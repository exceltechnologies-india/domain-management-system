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

// ─── Runtime gate ─────────────────────────────────────────────────────────────

/**
 * May this process contact a real provider at all?
 *
 * The header above says this file answers "is it safe to load real data right
 * now", not "is it safe forever". This is the forever half, and it exists
 * because the engine changed what a dev machine can do.
 *
 * ─── THE EXPOSURE, CONCRETELY ────────────────────────────────────────────────
 * Engine commands in TEST mode still contact providers. That is stated plainly
 * in every handler — test mode means "no writes", not "offline". `hosting.suspend`
 * reads the DirectAdmin account, `dns.record.upsert` reads the zone,
 * `domain.renew` reads the order and its expiry. Those are real calls.
 *
 * So on a dev machine holding a restored production database, one real
 * credential pasted into `.env.docker` is enough to have a "safe" dry run read
 * a live customer's DNS. And `LIVE_COMMANDS_ENABLED` does not help: it gates
 * live mode, and this is test mode behaving exactly as designed.
 *
 * ─── THE RULE ────────────────────────────────────────────────────────────────
 * A NON-PRODUCTION build must not talk to a provider that can answer.
 *
 *   production build          → allowed. That is the point of production.
 *   dev/test + inert config   → allowed, and harmless: `.invalid` cannot
 *                               resolve, so the call fails at DNS either way.
 *                               Allowing it keeps the local path exercisable.
 *   dev/test + REAL host      → REFUSED. This is the stray-credential case and
 *                               the only one that was ever dangerous.
 *
 * Note which way the default falls. `assessStackInertness` treats an ABSENT
 * variable as live, so a dev machine with no provider config is refused rather
 * than waved through. That is deliberate and inherited: a guard that treats
 * unknown as safe is how the one case nobody enumerated gets through.
 */
export interface ProviderSafety {
  allowed: boolean;
  /** Why, in words a caller can put in a 503. Empty when allowed. */
  reason: string;
}

export function checkProviderSafety(
  env: Record<string, string | undefined> = process.env
): ProviderSafety {
  if (env.NODE_ENV === "production") {
    return { allowed: true, reason: "" };
  }

  const report = assessStackInertness(env);
  if (report.inert) {
    return { allowed: true, reason: "" };
  }

  const named = report.live
    .map((l) => `${l.key} (${l.reaches})`)
    .join(", ");

  return {
    allowed: false,
    reason:
      `This is not a production build (NODE_ENV=${env.NODE_ENV ?? "unset"}), and these outbound ` +
      `paths are configured to reach something real: ${named}. Engine commands contact ` +
      `providers even in test mode — a dry run READS live DNS, hosting and registrar data — so ` +
      `the command is refused rather than allowed to touch a real customer from a dev machine. ` +
      `Point them at a .invalid host (or use rzp_test_ keys) to work locally, or run this on ` +
      `production.`,
  };
}
