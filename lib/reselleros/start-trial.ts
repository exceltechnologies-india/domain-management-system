/**
 * Start the in-panel free hosting trial IN RESELLEROS.
 *
 * Owner, 26 Sep 2026: "Move it to ResellerOS". The panel's Start-trial no
 * longer creates a trial in DMS. It calls
 * `POST {RESELLEROS_SERVER_URL}/api/dms/start-trial` (ResellerOS f514758b),
 * which runs the site's own trial code: Starter only, one trial per customer
 * across both apps (checked against DMS's shared trial record), a
 * confirm-your-email link to the customer, and the account created by the DMS
 * engine (`hosting.provision` trial mode) only after they confirm. ResellerOS
 * then knows the trial, reminds before it ends, and quotes the conversion.
 *
 * Never retried: a request that timed out may have started the trial and sent
 * the confirm email; the customer is told to check their email rather than
 * the app guessing and sending a second one.
 */
import { classifyTransport } from "@/lib/integrations/transport";
import { readPanelOrderConfig, supportEmail } from "./panel-order";

export interface StartTrialBody {
  dmsUserId: string;
  fullName: string;
  companyName?: string;
  email: string;
  phone: string;
  domain?: string;
  cycle: "monthly" | "yearly";
}

export type StartTrialOutcome =
  | { kind: "ok"; leadId: string | null; trialEnds: string | null }
  | { kind: "already_trialled"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "not_configured"; missing: string[] }
  | { kind: "config"; status: number; detail: string }
  | { kind: "unreachable"; detail: string; mayHaveStarted: boolean };

function transportError(err: unknown): unknown {
  if (err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") return cause;
  }
  return err;
}

export async function startTrialInResellerOs(
  body: StartTrialBody,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<StartTrialOutcome> {
  const cfg = readPanelOrderConfig(options.env);
  if (!cfg.ok) return { kind: "not_configured", missing: cfg.missing };
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${cfg.config.baseUrl}/api/dms/start-trial`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.config.apiKey}` },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (err) {
    const transport = classifyTransport(transportError(err), true);
    return {
      kind: "unreachable",
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      mayHaveStarted: transport !== "not_sent",
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
      trialEnds: typeof b.trialEnds === "string" ? b.trialEnds : null,
    };
  }
  if (res.status === 409 && b.alreadyTrialled === true) {
    return { kind: "already_trialled", message: error ?? "You've already had a free trial with us. No new trial was started." };
  }
  if (res.status === 400) {
    return { kind: "refused", message: error ?? "ResellerOS could not accept this trial request. No trial was started." };
  }
  if (res.status === 401 || res.status === 403 || res.status === 503) {
    return { kind: "config", status: res.status, detail: error ?? `HTTP ${res.status}` };
  }
  if (res.status === 500 && error) return { kind: "failed", message: error };
  // Anything else: ResellerOS may have got part of the way.
  return { kind: "unreachable", detail: `HTTP ${res.status}${error ? `: ${error}` : ""}`, mayHaveStarted: true };
}

/** §7 copy for every non-ok outcome. ResellerOS's own words where it gave any. */
export function startTrialRefusalMessage(
  outcome: Exclude<StartTrialOutcome, { kind: "ok" }>,
  support: string = supportEmail(),
): string {
  switch (outcome.kind) {
    case "already_trialled":
    case "refused":
    case "failed":
      return outcome.message;
    case "not_configured":
    case "config":
      return (
        "We couldn't start your free trial right now. Nothing was charged. " +
        "Our trial service is not set up correctly on our side — this is not a problem with your details. " +
        `Please try again later, or email ${support}.`
      );
    case "unreachable":
      return outcome.mayHaveStarted
        ? "We couldn't confirm your free trial. Nothing was charged. " +
            "Our trial service took too long to answer, so it may have gone through. " +
            `Please check your email for a confirmation link before trying again, or email ${support}.`
        : "We couldn't start your free trial. Nothing was charged. " +
            `Our trial service can't be reached right now. Please try again in a few minutes, or email ${support}.`;
  }
}

export const TRIAL_STARTED_MESSAGE =
  "Check your email to confirm; your trial account is created once you confirm.";
