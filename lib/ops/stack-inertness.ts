/**
 * Can this stack reach the outside world?
 *
 * Asked before loading a production database dump onto a dev machine. The
 * restore itself is harmless; the app that runs against the data afterwards is
 * not. DMS has crons that email customers, renew domains and provision
 * hosting, and with real rows loaded those crons are pointed at real people.
 *
 * There are exactly four ways a row in this database reaches someone: the
 * registrar, the hosting panel, SMTP, and the payment gateway. A stack is
 * inert when all four are demonstrably unreachable.
 *
 * This is a CONFIGURATION check, not an isolation check, and the difference
 * matters: the container has working internet (Todos.md §F). A `.invalid` host
 * cannot resolve, so it cannot be reached — but nothing stops someone editing
 * the value later. This answers "is it safe to load real data right now", not
 * "is it safe forever".
 */

export interface OutboundPath {
  /** Env var that decides whether this path can be reached. */
  key: string;
  /** What gets out if it can. */
  reaches: string;
  /** True when the configured value cannot reach anything real. */
  isInert: (value: string) => boolean;
}

/**
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so a
 * host under it cannot be contacted by accident. Matched with a boundary so
 * `.invalid.example.com` — a real, resolvable host — is NOT treated as inert.
 */
export function isInvalidHost(value: string): boolean {
  return /\.invalid(?:$|[:/?#])/i.test(value.trim());
}

export const OUTBOUND_PATHS: readonly OutboundPath[] = Object.freeze([
  { key: "RESELLERCLUB_API_URL", reaches: "domain registration / renewal", isInert: isInvalidHost },
  { key: "DIRECTADMIN_URL", reaches: "hosting provisioning", isInert: isInvalidHost },
  { key: "SMTP_HOST", reaches: "email to customers", isInert: isInvalidHost },
  {
    key: "RAZORPAY_KEY_ID",
    reaches: "payments",
    // Razorpay has no .invalid equivalent; the test-mode prefix is the signal.
    isInert: (v) => /^rzp_test_/.test(v.trim()),
  },
]);

export interface InertnessReport {
  inert: boolean;
  /** Paths that can still reach something real, with the offending value. */
  live: Array<{ key: string; reaches: string; value: string | null }>;
}

/**
 * An ABSENT variable counts as live, not inert.
 *
 * That is the load-bearing default. An unset SMTP_HOST might mean "email is
 * switched off", or it might mean the container falls back to a default that
 * works — and this function cannot tell which. Treating unknown as safe is how
 * a guard lets through the one case nobody thought about.
 */
export function assessStackInertness(env: Record<string, string | undefined>): InertnessReport {
  const live = OUTBOUND_PATHS.filter((p) => {
    const v = env[p.key];
    return v === undefined || v === "" || !p.isInert(v);
  }).map((p) => ({ key: p.key, reaches: p.reaches, value: env[p.key] ?? null }));

  return { inert: live.length === 0, live };
}
