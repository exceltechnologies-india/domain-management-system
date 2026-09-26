/**
 * Ask ResellerOS whether this customer may start a free hosting trial.
 *
 * Owner, 26 Sep 2026: "Ask ResellerOS instead". The panel's trial PRE-check
 * (app/api/user/hosting/trial-eligibility) used to answer from DMS's own
 * history, while the trial itself is started by ResellerOS (round 4) — two
 * deciders that could disagree. ResellerOS's
 * `POST /api/dms/trial-eligibility` (acfc4512) runs the SAME function its
 * `startHostingTrial` uses, so the button and the checkout now give one answer.
 *
 * Fail closed: anything but a clear 200 is `cannot_check`. That includes
 * ResellerOS's 503 (its trial history was unreadable), a timeout, an
 * unreachable server, a missing key and a malformed reply. The caller must
 * never read `cannot_check` as eligible, and never fall back to DMS's own
 * history.
 *
 * Retry: the check is read-only, so ONE short retry is made when the
 * connection was refused before anything was sent (`not_sent`). A timeout is
 * not retried — the customer waited long enough already, and the answer
 * "cannot check right now" is the honest one.
 */
import { classifyTransport } from "@/lib/integrations/transport";
import { readPanelOrderConfig } from "./panel-order";

export interface TrialEligibilityQuery {
  email: string;
  phone?: string;
  domain?: string;
}

export type TrialEligibilityOutcome =
  | { kind: "eligible" }
  | { kind: "not_eligible"; reason: string }
  | { kind: "cannot_check"; detail: string };

const RETRY_DELAY_MS = 300;

function transportError(err: unknown): unknown {
  if (err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") return cause;
  }
  return err;
}

export async function checkTrialEligibility(
  query: TrialEligibilityQuery,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    env?: Record<string, string | undefined>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<TrialEligibilityOutcome> {
  const cfg = readPanelOrderConfig(options.env);
  if (!cfg.ok) return { kind: "cannot_check", detail: `not configured: ${cfg.missing.join(", ")}` };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const send = () =>
    fetchImpl(`${cfg.config.baseUrl}/api/dms/trial-eligibility`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.config.apiKey}` },
      body: JSON.stringify(query),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });

  let res: Response | null = null;
  for (let attempt = 1; attempt <= 2 && !res; attempt++) {
    try {
      res = await send();
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      // Only a refusal before anything was sent is worth one more try.
      if (attempt === 1 && classifyTransport(transportError(err), true) === "not_sent") {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { kind: "cannot_check", detail };
    }
  }
  if (!res) return { kind: "cannot_check", detail: "no response" };

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const b = (json ?? {}) as Record<string, unknown>;

  if (res.status === 200 && b.eligible === true) return { kind: "eligible" };
  if (res.status === 200 && b.eligible === false) {
    const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason : null;
    // A refusal with no reason is still a refusal; say so plainly.
    return { kind: "not_eligible", reason: reason ?? "A free trial isn't available for this account." };
  }
  const error = typeof b.error === "string" ? `: ${b.error}` : "";
  return { kind: "cannot_check", detail: `HTTP ${res.status}${error}` };
}

/** What the customer sees when the check could not be made. Never "eligible". */
export const CANNOT_CHECK_TRIAL_MESSAGE =
  "We can't check whether you can start a free trial right now, so it can't be started yet. " +
  "Nothing was charged. Please try again in a few minutes, or contact support.";
