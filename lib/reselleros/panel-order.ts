/**
 * Create the Razorpay order for an in-panel purchase — AT RESELLEROS.
 *
 * Owner decision 30 (25 Sep 2026): ResellerOS creates every Razorpay order,
 * including a purchase made inside this panel. DMS sends the cart to
 * `POST {RESELLEROS_SERVER_URL}/api/dms/panel-order`, ResellerOS re-prices it
 * (the browser's and DMS's prices are never sent), creates the quote and the
 * Razorpay order on ITS account, and returns what Razorpay Checkout needs.
 * After payment, ResellerOS's own webhook records the payment and queues
 * provisioning back to this app through the engine. DMS records nothing.
 *
 * If ResellerOS cannot be reached the purchase is REFUSED. There is no DMS
 * fallback order: decision 30 replaced decision 16 ("take payment, bill
 * later"), so there is no queue or retry of a bill request here either.
 *
 * ── Why a POST is never retried ──────────────────────────────────────────
 * The POST creates a quote number at ResellerOS (from its gapless series) and
 * a Razorpay order. A request that timed out after it left may well have done
 * both. A second attempt would create a second quote. That duplicate is only
 * an UNPAID quote — nobody is charged twice, because payment happens in the
 * browser against one order id — but it is a real document with a real number,
 * so this module never repeats the call on its own. `mayHaveCreated` tells the
 * caller to say so to the customer instead.
 *
 * The outcome is classified by WHO CAN FIX IT (AGENTS.md L6):
 *   ok            — open Razorpay with the returned key and order id.
 *   refused       — ResellerOS answered 400. Its message is written for the
 *                   customer ("that domain is taken", "add your address") and
 *                   is shown as-is.
 *   not_configured— DMS itself lacks RESELLEROS_SERVER_URL / DMS_PANEL_API_KEY.
 *   config        — ResellerOS refused OUR key (401) or has no payments set up
 *                   (503). Ours to fix, never the customer's.
 *   unreachable   — no usable answer: network failure, timeout, 5xx, or a reply
 *                   we cannot read. `mayHaveCreated` says whether the request may
 *                   have been processed.
 */
import { classifyTransport } from "@/lib/integrations/transport";

export type PanelOrderSku =
  | "hosting:starter"
  | "hosting:standard"
  | "hosting:plus"
  | `domain:${string}`
  | "mailbox:anutech";

export interface PanelOrderLine {
  sku: PanelOrderSku;
  qty: number;
  cycle?: "monthly" | "yearly";
  /** Required on a domain line: the full name being registered. */
  domain?: string;
}

export interface PanelOrderAddress {
  line1: string;
  city: string;
  state: string;
  zipcode: string;
  country?: string;
}

/** The body ResellerOS's `/api/dms/panel-order` accepts. No prices, ever. */
export interface PanelOrderRequest {
  dmsUserId: string;
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  gstin?: string;
  /** Required when a hosting line is present: the domain the hosting is set up on. */
  domain?: string;
  lines: PanelOrderLine[];
  /** Required when any domain line is present: the registrant's address. */
  address?: PanelOrderAddress;
  coupon?: string;
}

export interface PanelOrder {
  orderId: string;
  /** Paise — Razorpay's unit. Not a DMS money figure. */
  amount: number;
  currency: string;
  razorpayKeyId: string;
  razorpayMode?: string;
  quoteId?: string;
  leadId?: string;
  customerName?: string;
  /** Whole rupees, as ResellerOS priced it. */
  totalRupees?: number;
}

export type PanelOrderOutcome =
  | { kind: "ok"; order: PanelOrder }
  | {
      kind: "refused";
      message: string;
      needAddress?: boolean;
      needDomain?: boolean;
      unpriced?: unknown;
    }
  | { kind: "not_configured"; missing: string[] }
  | { kind: "config"; status: number; detail: string }
  | { kind: "unreachable"; detail: string; mayHaveCreated: boolean };

export interface PanelOrderConfig {
  baseUrl: string;
  apiKey: string;
}

/** ResellerOS's own minimum for DMS_PANEL_API_KEY. */
const MIN_KEY_LENGTH = 16;

/**
 * The server-to-server settings, or the names of the ones that are missing.
 *
 * `RESELLEROS_SERVER_URL` is deliberately NOT `NEXT_PUBLIC_RESELLEROS_URL`.
 * That one is inlined by `next build` (lib/reseller-os.ts), so a server call
 * reading it would be using whatever the image was built with, and it is the
 * PUBLIC origin — a container talking to ResellerOS may need a different,
 * internal address. A runtime variable, read per call, avoids both.
 */
export function readPanelOrderConfig(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: PanelOrderConfig } | { ok: false; missing: string[] } {
  const rawUrl = (env.RESELLEROS_SERVER_URL ?? "").trim();
  const apiKey = (env.DMS_PANEL_API_KEY ?? "").trim();
  const missing: string[] = [];
  // A bare host would resolve as a relative path inside fetch and fail in a
  // way that reads as "ResellerOS is down". Refuse it as unconfigured instead.
  if (!/^https?:\/\//i.test(rawUrl)) missing.push("RESELLEROS_SERVER_URL");
  if (apiKey.length < MIN_KEY_LENGTH) missing.push("DMS_PANEL_API_KEY");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { baseUrl: rawUrl.replace(/\/+$/, ""), apiKey } };
}

export interface CreatePanelOrderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** `fetch` wraps the socket error in `cause`; transport.ts reads `.code`. */
function transportError(err: unknown): unknown {
  if (err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") return cause;
  }
  return err;
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function readNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A 200 we can use, or null when a field Razorpay needs is missing. */
function parseOrder(body: unknown): PanelOrder | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const orderId = readString(b.orderId);
  const razorpayKeyId = readString(b.razorpayKeyId);
  const amount = readNumber(b.amount);
  if (b.success !== true || !orderId || !razorpayKeyId || amount === undefined || amount <= 0) {
    return null;
  }
  return {
    orderId,
    amount,
    currency: readString(b.currency) ?? "INR",
    razorpayKeyId,
    razorpayMode: readString(b.razorpayMode),
    quoteId: readString(b.quoteId),
    leadId: readString(b.leadId),
    customerName: readString(b.customerName),
    totalRupees: readNumber(b.totalRupees),
  };
}

export async function createPanelOrder(
  request: PanelOrderRequest,
  options: CreatePanelOrderOptions = {},
): Promise<PanelOrderOutcome> {
  const cfg = readPanelOrderConfig(options.env);
  if (!cfg.ok) return { kind: "not_configured", missing: cfg.missing };

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${cfg.config.baseUrl}/api/dms/panel-order`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.config.apiKey}`,
      },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // The send was attempted, so only a proof that the connection never
    // opened (DNS, refused) makes this "nothing happened". A timeout is not
    // such a proof: ResellerOS may have created the quote and the order.
    const transport = classifyTransport(transportError(err), true);
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { kind: "unreachable", detail, mayHaveCreated: transport !== "not_sent" };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const errorText = readString((body as { error?: unknown } | null)?.error);

  if (res.status === 200) {
    const order = parseOrder(body);
    if (order) return { kind: "ok", order };
    // A 200 we cannot use: ResellerOS may well have created the order.
    return { kind: "unreachable", detail: "ResellerOS answered 200 without a usable order", mayHaveCreated: true };
  }
  if (res.status === 400) {
    const b = (body ?? {}) as Record<string, unknown>;
    return {
      kind: "refused",
      // ResellerOS writes its 400s for the customer. Without one, say what
      // we know rather than invent a reason.
      message: errorText ?? "ResellerOS could not accept this order. Nothing was charged.",
      needAddress: b.needAddress === true ? true : undefined,
      needDomain: b.needDomain === true ? true : undefined,
      unpriced: b.unpriced,
    };
  }
  if (res.status === 401 || res.status === 403 || res.status === 503) {
    return { kind: "config", status: res.status, detail: errorText ?? `HTTP ${res.status}` };
  }
  // 5xx and anything unexpected: ResellerOS answered, but it may have got
  // part of the way (a quote allocated, then a failure), so do not promise
  // the customer that nothing exists.
  return {
    kind: "unreachable",
    detail: `HTTP ${res.status}${errorText ? `: ${errorText}` : ""}`,
    mayHaveCreated: res.status >= 500,
  };
}

/** The support address customers are pointed at when a purchase is refused. */
export function supportEmail(env: Record<string, string | undefined> = process.env): string {
  return (env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "").trim() || "support@anutech.in";
}

/**
 * What the customer is told for each non-ok outcome — what happened, why,
 * and what to do next (AGENTS.md §7). A config fault is never described as
 * the customer's, and a timed-out order is never described as "nothing
 * happened".
 */
export function panelOrderRefusalMessage(
  outcome: Exclude<PanelOrderOutcome, { kind: "ok" }>,
  support: string = supportEmail(),
): string {
  switch (outcome.kind) {
    case "refused":
      return outcome.message;
    case "not_configured":
    case "config":
      return (
        "Online purchase isn't available right now. Nothing was charged. " +
        "Our payment service is not set up correctly on our side — this is not a problem with your details. " +
        `Please try again later, or email ${support} and we'll help you buy it.`
      );
    case "unreachable":
      return outcome.mayHaveCreated
        ? "We couldn't confirm your order. Nothing was charged. " +
            "Our billing service took too long to answer, so an unpaid order may have been created for you. " +
            "Please check your email and the Billing page before trying again. " +
            `If it isn't there in a few minutes, try again or email ${support}.`
        : "We couldn't start your order. Nothing was charged. " +
            "Our billing service can't be reached right now. " +
            `Please try again in a few minutes, or email ${support}.`;
  }
}
