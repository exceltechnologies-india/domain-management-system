/**
 * How far did a handler's provider call get?
 *
 * Phase 1 built `classifyTransport(error, sentBefore)` and said, correctly,
 * that `sentBefore` has to come from "the function doing the sending" because
 * no amount of message-matching recovers it. Phase 4 then wrote the command
 * route's catch with this comment:
 *
 *     "no handler here contacts anything yet, and the ones that do will not
 *      rely on this branch"
 *
 * That was true when it was written and stopped being true in Phase 6, which
 * shipped three handlers that DO contact providers and DO throw from that
 * branch. The result: a DNS write that died mid-flight was recorded
 * `transport: "not_sent"`, the subject claim was released, and the caller was
 * told "Nothing was changed" about a request ResellerClub may well have
 * applied. That is the exact failure `classifyTransport` exists to prevent,
 * arriving through the one door nobody had wired it to.
 *
 * This module is that wiring. A thrown error carries the transport it earned,
 * and the route reads it instead of assuming.
 *
 * ─── THREE OUTCOMES, NOT TWO ─────────────────────────────────────────────────
 * The tempting simplification is a boolean — "did we send?". It is wrong here
 * and expensively so:
 *
 *  - **not_sent** — validation, a missing record, a failed READ. Nothing was
 *    attempted, so the claim releases and a retry is free. This is the default
 *    for an unbranded error, which is why reads are deliberately NOT wrapped:
 *    a read that fails changed nothing.
 *  - **sent_unknown** — the write left and we never learned its fate. The claim
 *    is HELD and a human reconciles. Use `attemptProviderWrite`.
 *  - **responded** — the provider answered, and its answer was "no". We know
 *    the work did not happen, so holding the subject would be pure toil.
 *    Use `providerRefused`.
 *
 * Collapsing the third into the second is how a guard becomes a nuisance and
 * then gets deleted (AGENTS.md L103): every refused DNS record would park a
 * subject for a human who has nothing to decide.
 */
import { classifyTransport, type Transport } from "./transport";

/**
 * `Symbol.for` rather than a class and `instanceof`.
 *
 * AGENTS.md L6: a status that depends on how the error travelled is a status
 * that will be wrong one day — `instanceof` stops holding across a re-throw
 * boundary while the value itself survives. A branded property travels with
 * the object.
 */
const TRANSPORT_BRAND = Symbol.for("engine.transport");

/** Attach a transport to an error without disturbing its message or stack. */
export function brandTransport<E>(error: E, transport: Transport): E {
  if (error !== null && typeof error === "object") {
    Object.defineProperty(error, TRANSPORT_BRAND, {
      value: transport,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

/**
 * Read the transport off an error.
 *
 * `null` means the error was never branded — which is the honest answer, not
 * a transport. The route turns that into `not_sent`, and it is the route's
 * decision to make: only it knows that an unbranded throw came from code that
 * had not reached the wrapper yet.
 */
export function transportOf(error: unknown): Transport | null {
  if (error === null || typeof error !== "object") return null;
  const value = (error as Record<symbol, unknown>)[TRANSPORT_BRAND];
  return value === "not_sent" || value === "sent_unknown" || value === "responded"
    ? value
    : null;
}

/**
 * Wrap a provider WRITE — the call that can change something at the far end.
 *
 * On a throw the error is branded with `classifyTransport(err, true)`, so
 * ENOTFOUND/ECONNREFUSED/EAI_AGAIN still come back `not_sent` (the connection
 * was never established) while ECONNRESET and ETIMEDOUT correctly become
 * `sent_unknown`.
 *
 * Do NOT wrap reads. A read that fails changed nothing, and branding it would
 * hold a subject claim for a human to resolve a question with no consequences.
 */
export async function attemptProviderWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw brandTransport(err, classifyTransport(err, true));
  }
}

/**
 * The provider answered, and the answer was a refusal.
 *
 * Distinct from a throw inside `attemptProviderWrite`: here the far end spoke,
 * so we know the work did not happen. The claim releases and the operator gets
 * the provider's own words rather than a held subject.
 */
export function providerRefused(message: string): Error {
  return brandTransport(new Error(message), "responded");
}
