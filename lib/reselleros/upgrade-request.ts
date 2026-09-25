/**
 * Ask ResellerOS to bill a hosting plan upgrade.
 *
 * Owner decision, 25 Sep 2026 ("Request, billed by ResellerOS"): DMS takes no
 * payment for an upgrade. The panel's Upgrade button sends a REQUEST to
 * `POST {RESELLEROS_SERVER_URL}/api/dms/upgrade-request` (ResellerOS
 * 8757adb4). ResellerOS records it as a lead, staff send a quote, the
 * customer pays that quote in ResellerOS, and the plan is changed after.
 *
 * `estimateRupees` is DMS's prorated figure and is only an ESTIMATE on the
 * lead — the quote is the price.
 *
 * Asking twice is safe at ResellerOS (an open request is returned, not a
 * second lead), but this still never retries on its own: a timed-out request
 * may have been recorded, and the customer is told to check before asking
 * again rather than the app guessing.
 */
import { classifyTransport } from "@/lib/integrations/transport";
import { readPanelOrderConfig, supportEmail } from "./panel-order";

export interface UpgradeRequestBody {
  dmsUserId: string;
  email: string;
  fullName: string;
  phone?: string;
  companyName?: string;
  domain: string;
  currentPlan: string;
  targetPlan: string;
  /** Whole rupees incl. GST — DMS's prorated estimate. */
  estimateRupees?: number;
  /** ISO date the hosting currently expires. */
  expiresAt?: string;
}

export type UpgradeRequestOutcome =
  | { kind: "ok"; leadId: string | null; alreadyRequested: boolean }
  | { kind: "refused"; message: string }
  | { kind: "not_configured"; missing: string[] }
  | { kind: "config"; status: number; detail: string }
  | { kind: "failed"; message: string }
  | { kind: "unreachable"; detail: string; mayHaveRecorded: boolean };

const DEFAULT_TIMEOUT_MS = 15_000;

function transportError(err: unknown): unknown {
  if (err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") return cause;
  }
  return err;
}

export async function sendUpgradeRequest(
  body: UpgradeRequestBody,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<UpgradeRequestOutcome> {
  const cfg = readPanelOrderConfig(options.env);
  if (!cfg.ok) return { kind: "not_configured", missing: cfg.missing };
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${cfg.config.baseUrl}/api/dms/upgrade-request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.config.apiKey}` },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const transport = classifyTransport(transportError(err), true);
    return {
      kind: "unreachable",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      mayHaveRecorded: transport !== "not_sent",
    };
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const b = (json ?? {}) as Record<string, unknown>;
  const error = typeof b.error === "string" && b.error.trim() ? b.error : null;

  if (res.status === 200 && b.success === true) {
    return {
      kind: "ok",
      leadId: typeof b.leadId === "string" ? b.leadId : null,
      alreadyRequested: b.alreadyRequested === true,
    };
  }
  if (res.status === 400) {
    return { kind: "refused", message: error ?? "ResellerOS could not accept this upgrade request. Nothing was charged." };
  }
  if (res.status === 401 || res.status === 403 || res.status === 503) {
    return { kind: "config", status: res.status, detail: error ?? `HTTP ${res.status}` };
  }
  if (res.status === 500 && error) {
    // ResellerOS's own words; it already says nothing was charged.
    return { kind: "failed", message: error };
  }
  return { kind: "unreachable", detail: `HTTP ${res.status}${error ? `: ${error}` : ""}`, mayHaveRecorded: true };
}

/** §7 copy for every non-ok outcome. */
export function upgradeRequestRefusalMessage(
  outcome: Exclude<UpgradeRequestOutcome, { kind: "ok" }>,
  support: string = supportEmail(),
): string {
  switch (outcome.kind) {
    case "refused":
    case "failed":
      return outcome.message;
    case "not_configured":
    case "config":
      return (
        "We couldn't send your upgrade request right now. Nothing was charged and your plan is unchanged. " +
        "Our billing service is not set up correctly on our side. " +
        `Please try again later, or email ${support} and we'll arrange the upgrade.`
      );
    case "unreachable":
      return outcome.mayHaveRecorded
        ? "We couldn't confirm your upgrade request. Nothing was charged and your plan is unchanged. " +
            "Our billing service took too long to answer, so the request may have been recorded. " +
            `Please check your email before asking again, or email ${support}.`
        : "We couldn't send your upgrade request. Nothing was charged and your plan is unchanged. " +
            `Our billing service can't be reached right now. Please try again in a few minutes, or email ${support}.`;
  }
}
