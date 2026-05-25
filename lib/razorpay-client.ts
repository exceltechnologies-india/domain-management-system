/**
 * Razorpay SDK client — single source of truth for the SDK instance and
 * its typed surface.
 *
 * The official `razorpay` npm package returns very loose types (most
 * methods resolve to `any` or `Promise<unknown>`). Before this module
 * existed, ten callsites across `lib/razorpay.ts` + `lib/razorpay-payments.ts`
 * each escape-hatched the SDK with `as unknown as OurInterface` casts,
 * and two separate files even constructed their own `new Razorpay(...)`
 * instances. Rescan-4 L1 collapses all of that into one cast and one
 * instance here.
 *
 * Callers should prefer `razorpayClient.X.Y(...)` — it returns our
 * strongly-typed interfaces directly. The raw `razorpay` export remains
 * for places that need SDK-level introspection (e.g. admin/system-health).
 */
import Razorpay from "razorpay";
import type {
  RazorpayPaymentDetails,
  RazorpayOrderDetails,
  RazorpaySubscription,
  RazorpayRefund,
  RazorpayPlan,
} from "@/lib/types";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  throw new Error("Razorpay configuration is missing");
}

const sdkClient = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// 30s upper bound on every Razorpay HTTP call. The SDK's internal axios
// client has no default timeout — a hung Razorpay slot would otherwise
// stall payment-verify indefinitely (mirrors the resolved [H3] Zoho axios
// timeout). Set on `api.defaults` because the SDK doesn't expose a
// constructor `timeout` option in v2.x.
{
  const apiClient = (sdkClient as unknown as { api?: { defaults?: { timeout?: number } } }).api;
  if (apiClient?.defaults) {
    apiClient.defaults.timeout = 30_000;
  }
}

/**
 * Shape of a single Razorpay payment record as returned by
 * `payments.fetch` / `payments.all`. The SDK's own type is `any`;
 * this is the subset we actually consume in the codebase.
 *
 * Defined here (rather than on razorpay-payments.ts) so the typed
 * facade can reference it without inducing a circular import.
 */
export interface RazorpayPayment {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  method: string;
  description?: string;
  amount_refunded: number;
  refund_status?: string;
  captured: boolean;
  email: string;
  contact?: string;
  notes: Record<string, unknown>;
  fee?: number;
  tax?: number;
  error_code?: string;
  error_description?: string;
  error_source?: string;
  error_step?: string;
  error_reason?: string;
  acquirer_data?: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface RazorpayPaymentListResponse {
  entity: string;
  count: number;
  items: RazorpayPayment[];
}

export interface CreateOrderOptions {
  amount: number;
  currency: string;
  receipt: string;
  payment_capture: 1;
  notes?: Record<string, string>;
}

export interface CreateOrderResponse {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
}

export interface CreateSubscriptionOptions {
  plan_id: string;
  customer_notify: 0 | 1;
  total_count: number;
  quantity: number;
  addons: never[];
  notes: Record<string, string>;
  start_at?: number;
}

export interface CreatePlanOptions {
  period: "monthly" | "yearly";
  interval: number;
  item: {
    name: string;
    amount: number;
    currency: string;
    description: string;
  };
}

export interface ListPaymentsOptions {
  count?: number;
  skip?: number;
  from?: number;
  to?: number;
}

interface TypedRazorpayClient {
  orders: {
    create(opts: CreateOrderOptions): Promise<CreateOrderResponse>;
    fetch(id: string): Promise<RazorpayOrderDetails>;
  };
  payments: {
    fetch(id: string): Promise<RazorpayPaymentDetails>;
    refund(
      id: string,
      opts: { payment_id: string; amount?: number }
    ): Promise<RazorpayRefund>;
    all(opts: ListPaymentsOptions): Promise<RazorpayPaymentListResponse>;
  };
  subscriptions: {
    create(opts: CreateSubscriptionOptions): Promise<RazorpaySubscription>;
    cancel(id: string): Promise<RazorpaySubscription>;
  };
  plans: {
    create(opts: CreatePlanOptions): Promise<RazorpayPlan>;
  };
}

/**
 * The one and only `as unknown as ...` cast for the Razorpay SDK in
 * the entire codebase. Bridges the SDK's loose types to our strong
 * interfaces. Callers receive strongly-typed results without needing
 * escape-hatch casts in their own files.
 */
export const razorpayClient = sdkClient as unknown as TypedRazorpayClient;

/**
 * Raw SDK instance. Exported for callers that need SDK-level
 * introspection (admin/system-health, for instance). New code should
 * prefer `razorpayClient` for typed access.
 */
export const razorpay = sdkClient;
