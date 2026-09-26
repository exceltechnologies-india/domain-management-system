/**
 * "Has this customer had a free hosting trial — in EITHER app?"
 *
 * Owner rule, 24 Sep 2026: one free trial per customer. A customer can start one
 * on the ResellerOS site (no DMS account at the time) or in the DMS customer
 * panel, and until now each app only looked at its own trials. DMS is where the
 * two meet (see models/ExternalTrial): this function reads both, and it is called
 * by the engine route ResellerOS asks, and by DMS's own trial gates.
 *
 * "The same customer" is any one of: the same email (case-insensitive), the same
 * phone number (last 10 digits, so +91 and spaces do not matter), or the same
 * website domain. Those are the identifiers both apps hold.
 */
import connectDB from "@/lib/mongodb";
import ExternalTrial from "@/models/ExternalTrial";
import Hosting from "@/models/Hosting";
import Order from "@/models/Order";
import User from "@/models/User";

export interface TrialKeys {
  email?: string | null;
  phone?: string | null;
  domain?: string | null;
}

export type PriorTrial =
  | { found: false }
  | { found: true; where: "reselleros" | "dms"; startedAt: Date | null };

/** Normalise the three identifiers the same way on every path. */
export function trialKeys(k: TrialKeys): { email: string; phoneKey: string; domain: string } {
  const email = (k.email ?? "").trim().toLowerCase();
  const digits = (k.phone ?? "").replace(/\D/g, "");
  const phoneKey = digits.length >= 10 ? digits.slice(-10) : "";
  const domain = (k.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  return { email, phoneKey, domain: domain.length >= 3 ? domain : "" };
}

/**
 * The trial being provisioned right now, so it does not count against itself.
 *
 * `hosting.provision` with `trial: true` checks history before creating, and at
 * that moment the SAME trial can already be on record twice: ResellerOS records
 * it here (ExternalTrial, `ref` = its lead id) before asking for the account, and
 * a retried command finds the Hosting row its first attempt wrote. Each is
 * excluded by its exact id — never by customer, which would let a genuine
 * second trial through.
 */
export interface IgnoreOwnTrial {
  /** ExternalTrial.ref of the trial being provisioned (ResellerOS's lead id). */
  externalRef?: string;
  /** Hosting.orderId of the row this very provision writes (`rsos-trial:<sourceRef>`). */
  hostingOrderId?: string;
}

/**
 * The earliest trial matching any of the keys, or `{ found: false }`.
 *
 * Throws on a database error: callers must refuse the trial rather than read an
 * unanswered question as "no earlier trial" (AGENTS.md §2).
 */
export async function findPriorTrial(k: TrialKeys, ignore: IgnoreOwnTrial = {}): Promise<PriorTrial> {
  const { email, phoneKey, domain } = trialKeys(k);
  if (!email && !phoneKey && !domain) return { found: false };
  await connectDB();
  const notOwnExternal = ignore.externalRef ? { ref: { $ne: ignore.externalRef } } : {};
  const notOwnHosting = ignore.hostingOrderId ? { orderId: { $ne: ignore.hostingOrderId } } : {};

  // 1. Trials ResellerOS started and recorded here.
  const extOr: Record<string, string>[] = [];
  if (email) extOr.push({ email });
  if (phoneKey) extOr.push({ phoneKey });
  if (domain) extOr.push({ domain });
  const ext = await ExternalTrial.findOne({ $or: extOr, ...notOwnExternal }).sort({ createdAt: 1 }).lean();
  if (ext) return { found: true, where: "reselleros", startedAt: ext.createdAt ?? null };

  // 2. DMS's own trials: a trial hosting on this domain…
  if (domain) {
    const h = await Hosting.findOne({ isTrial: true, domainName: domain, ...notOwnHosting }).sort({ createdAt: 1 }).lean<{ startDate?: Date }>();
    if (h) return { found: true, where: "dms", startedAt: h.startDate ?? null };
  }

  // …or any DMS account with this email or phone that has had one. Same test
  // the (deleted, 26 Sep 2026) userHasPriorTrialOrder used (an abandoned-at-mandate checkout does not count),
  // plus trial hostings, which a manual-flow trial always has.
  const userOr: Record<string, unknown>[] = [];
  if (email) userOr.push({ email });
  // phoneKey is digits only, so it is safe inside a regex.
  if (phoneKey) userOr.push({ phone: { $regex: `${phoneKey}$` } });
  if (!userOr.length) return { found: false };
  const users = await User.find({ $or: userOr }).select("_id").limit(20).lean();
  if (!users.length) return { found: false };
  const ids = users.map((u) => u._id);

  const order = await Order.findOne({
    userId: { $in: ids },
    orderType: "hosting_trial",
    $nor: [{ status: "pending", razorpayPaymentId: "pending" }],
  })
    .sort({ createdAt: 1 })
    .lean();
  if (order) return { found: true, where: "dms", startedAt: (order as { createdAt?: Date }).createdAt ?? null };

  const trialHosting = await Hosting.findOne({ isTrial: true, userId: { $in: ids }, ...notOwnHosting }).sort({ createdAt: 1 }).lean<{ startDate?: Date }>();
  if (trialHosting) return { found: true, where: "dms", startedAt: trialHosting.startDate ?? null };

  return { found: false };
}

/** The customer-facing refusal, one wording for both apps' gates. */
export function alreadyTrialledMessage(p: Extract<PriorTrial, { found: true }>): string {
  const when = p.startedAt
    ? ` (started ${p.startedAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })})`
    : "";
  return (
    `You've already had a free hosting trial with us${when}, and it's one per customer — matched on this email, phone number or domain. ` +
    "Nothing was charged. You can buy Starter now, or reply to our earlier email if you need more time on the trial."
  );
}

/** Record a trial another app started, so every later check sees it. Idempotent on `ref`. */
export async function recordExternalTrial(input: {
  ref: string;
  email: string;
  phone?: string | null;
  domain?: string | null;
  planId?: string;
  cycle?: "monthly" | "yearly";
}): Promise<{ created: boolean }> {
  const { email, phoneKey, domain } = trialKeys(input);
  await connectDB();
  const res = await ExternalTrial.updateOne(
    { ref: input.ref },
    {
      $setOnInsert: {
        source: "reselleros",
        ref: input.ref,
        email,
        ...(phoneKey ? { phoneKey } : {}),
        ...(domain ? { domain } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.cycle ? { cycle: input.cycle } : {}),
      },
    },
    { upsert: true },
  );
  return { created: (res.upsertedCount ?? 0) > 0 };
}
