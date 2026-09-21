/**
 * Did the request reach the other side?
 *
 * Every integration failure in this codebase currently collapses to a string,
 * and two very different situations produce indistinguishable ones:
 *
 *   - we threw while BUILDING the request — nothing was sent, the registrar
 *     has never heard of it, retrying is free;
 *   - the socket died AFTER the POST left — the registrar may have registered
 *     the domain, and retrying may register it a second time.
 *
 * On `registerDomain` those cost different money. A blind retry of the first
 * is correct; a blind retry of the second is a double registration that
 * nobody gets back. No amount of message-matching separates them, because the
 * message is written by a `catch` that cannot see how far the request got.
 *
 * So the distinction is recorded STRUCTURALLY, at the only place that knows:
 * the function doing the sending.
 *
 * This is the same shape as AGENTS.md L2 — classify a failure before retrying
 * it, default to not retrying — one layer lower. L2 is about which failures
 * are transient; this is about whether the failure happened before or after
 * the side effect.
 */

export type Transport =
  /**
   * The request was never sent. A validation throw, a parameter-build error, a
   * missing credential — anything that happened before the socket opened.
   * Nothing changed at the far end, so a retry is free.
   */
  | "not_sent"
  /**
   * The request left, and we do not know what happened to it. A socket reset,
   * a timeout, a connection dropped mid-flight. The far end MAY have done the
   * work. Never blind-retry this: reconcile first, or surface it.
   */
  | "sent_unknown"
  /**
   * The far end answered — including when the answer is an error. We know what
   * happened, so the response itself decides what to do next.
   */
  | "responded";

/** True when retrying cannot cause the work to happen twice. */
export function isSafeToRetry(transport: Transport): boolean {
  return transport === "not_sent";
}

/**
 * Classify a thrown error by how far the request got.
 *
 * `sentBefore` is what the caller knows and the error does not: whether the
 * send had been attempted by the time this threw. Everything hinges on it,
 * which is why it is a required argument rather than something inferred —
 * inferring it from an error code is exactly the guesswork this type exists
 * to remove.
 *
 * With `sentBefore === false` the answer is always `not_sent`, whatever the
 * error looks like. With `sentBefore === true` the answer is `sent_unknown`
 * unless the error proves the connection never established.
 */
export function classifyTransport(error: unknown, sentBefore: boolean): Transport {
  if (!sentBefore) return "not_sent";

  const code = readErrorCode(error);

  /**
   * These prove the request never reached a listening server: DNS did not
   * resolve, the port refused, the connection was not established. Nothing
   * was processed, so a retry is free.
   *
   * ECONNRESET and ETIMEDOUT are deliberately NOT here. A reset can arrive
   * after the bytes were delivered and acted upon, and a timeout means we
   * stopped waiting — neither says the far end did nothing. Treating them as
   * safe is the mistake this whole module exists to prevent.
   */
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN") {
    return "not_sent";
  }

  return "sent_unknown";
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A sentence for a human, given what we know about how far the request got.
 *
 * Kept beside the type because the whole point is that the caller stops
 * writing its own: "Failed to register domain" is what a `catch` says when it
 * does not know, and it is what sent people looking in the wrong place.
 */
export function describeTransport(transport: Transport): string {
  switch (transport) {
    case "not_sent":
      return "The request was never sent, so nothing changed at the provider. Safe to retry.";
    case "sent_unknown":
      return "The request was sent but the outcome is unknown — the provider may have completed it. Check before retrying.";
    case "responded":
      return "The provider responded.";
  }
}
