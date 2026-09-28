/**
 * Start paying a ResellerOS renewal bill from inside this panel (owner, 28 Sep 2026: "if an
 * existing user renews hosting or a domain, that happens inside the DMS customer portal").
 *
 * ResellerOS still owns the renewal: it wrote the renewal quote, prices it, and bills it. This
 * asks it to open a Razorpay order for that quote (`POST /api/dms/renewal-order`, the same
 * DMS_PANEL_API_KEY as a panel purchase), and the panel then opens Razorpay in its own frame.
 * Payment lands on ResellerOS's webhook, which renews through the engine (`hosting.renew` /
 * `domain.renew`) and so moves the expiry here. DMS writes nothing on any path.
 *
 * Unlike a purchase, starting a renewal payment creates no bill: the quote already exists and
 * a second Razorpay order for it is harmless (it is only paid if the customer pays it). So a
 * failure here can always honestly say "nothing was charged".
 */
import { readPanelOrderConfig, supportEmail } from "./panel-order";

export interface RenewalOrderRequest {
  quoteId: string;
  /** The signed-in account's email; ResellerOS matches it exactly to the quote's customer. */
  email: string;
  dmsUserId: string;
}

export interface RenewalOrder {
  orderId: string;
  /** Paise — Razorpay's unit. */
  amount: number;
  currency: string;
  razorpayKeyId: string;
  quoteId: string;
}

export type RenewalOrderOutcome =
  | { kind: "ok"; order: RenewalOrder }
  /** ResellerOS said no, for the customer (not yours, not a renewal, already paid, expired…). */
  | { kind: "refused"; status: number; message: string }
  | { kind: "not_configured"; missing: string[] }
  | { kind: "config"; status: number; detail: string }
  | { kind: "unreachable"; detail: string };

export interface CreateRenewalOrderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export async function createRenewalOrder(
  request: RenewalOrderRequest,
  options: CreateRenewalOrderOptions = {},
): Promise<RenewalOrderOutcome> {
  const cfg = readPanelOrderConfig(options.env);
  if (!cfg.ok) return { kind: "not_configured", missing: cfg.missing };

  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(`${cfg.config.baseUrl}/api/dms/renewal-order`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.config.apiKey}` },
      body: JSON.stringify(request),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  const errorText = str(body.error);

  if (res.status === 200) {
    const orderId = str(body.orderId), razorpayKeyId = str(body.razorpayKeyId), amount = num(body.amount);
    if (body.success !== true || !orderId || !razorpayKeyId || amount === undefined || amount <= 0) {
      return { kind: "unreachable", detail: "ResellerOS answered 200 without a usable order" };
    }
    return {
      kind: "ok",
      order: { orderId, amount, currency: str(body.currency) ?? "INR", razorpayKeyId, quoteId: str(body.quoteId) ?? request.quoteId },
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "config", status: res.status, detail: errorText ?? `HTTP ${res.status}` };
  }
  // ResellerOS's 503 is either "no panel key here" / "no Razorpay keys" (ours to fix) or a
  // database read that failed (try again). Both are told to the customer the same way.
  if (res.status === 503) return { kind: "config", status: 503, detail: errorText ?? "HTTP 503" };
  if (res.status >= 400 && res.status < 500) {
    return {
      kind: "refused",
      status: res.status,
      // ResellerOS writes its 4xx for the customer. Without one, say what we know.
      message: errorText ?? "We couldn't start this renewal payment. Nothing was charged.",
    };
  }
  return { kind: "unreachable", detail: `HTTP ${res.status}${errorText ? `: ${errorText}` : ""}` };
}

/** What the customer is told for each non-ok outcome (AGENTS.md §7). */
export function renewalOrderRefusalMessage(
  outcome: Exclude<RenewalOrderOutcome, { kind: "ok" }>,
  support: string = supportEmail(),
): string {
  switch (outcome.kind) {
    case "refused":
      return outcome.message;
    case "not_configured":
    case "config":
      return (
        "Online renewal isn't available right now. Nothing was charged. " +
        "Our payment service is not set up correctly on our side — this is not a problem with your account. " +
        `Please try again later, or pay from the link in your renewal email, or email ${support}.`
      );
    case "unreachable":
      return (
        "We couldn't start the renewal payment. Nothing was charged. Our billing service can't be reached right now. " +
        `Please try again in a few minutes, or pay from the link in your renewal email, or email ${support}.`
      );
  }
}
