/**
 * `hosting.renew` — record a hosting renewal the customer paid for in ResellerOS.
 *
 * ─── WHY IT EXISTS (owner, 25 Sep 2026) ──────────────────────────────────────
 * Billing and renewals belong to ResellerOS. When a customer paid a HOSTING
 * renewal there, nothing told DMS — so DMS's own expiry machinery (the daily
 * scheduler selects on `next_action_at`, then
 * `app/api/workers/process-hosting-expiry` suspends) later suspended an account
 * the customer had paid for. ResellerOS now sends this command after a paid
 * hosting renewal, and this handler moves the expiry.
 *
 * ─── IT SPENDS NOTHING, SO IT HAS NO SPEND LIMIT ─────────────────────────────
 * Unlike `domain.renew`, no rupee leaves at a registrar: the money was taken by
 * ResellerOS, and the only effect here is DMS's own `Hosting.expiryDate` (plus,
 * for a suspended account, a DirectAdmin unsuspend, which is free and
 * reversible). So there is no cost check and no daily cap. What it DOES need is
 * the same double-application defence `domain.renew` has, because a retry that
 * extended the expiry a second time would give away a term nobody paid for.
 *
 * ─── expiryBefore IS THE IDEMPOTENCY KEY (same design as domain.renew) ───────
 * `expiryBefore` is REQUIRED and is the expiry the CALLER observed (ResellerOS
 * reads `hostings[].expiryDate` from GET /api/integrations/engine/services and
 * sends `Math.floor(Date.parse(iso) / 1000)`). This handler never looks it up
 * for the caller — a freshly-read value always matches, which is precisely how
 * a retry would renew twice. It reads the current expiry only to COMPARE:
 *
 *   current == expiryBefore → the world is as the caller saw it. Extend.
 *   current >  expiryBefore → already extended since the caller looked. REFUSE.
 *   current <  expiryBefore → a view this row never had. REFUSE.
 *
 * The write itself is a compare-and-set on the same `expiryDate`, so even two
 * concurrent runs cannot both extend it.
 *
 * ─── AND THE SAME FIELD IS THE RECONCILER ────────────────────────────────────
 * Moved past `expiryBefore` → the renewal landed. Unchanged → it did not.
 *
 * ─── CALENDAR MONTHS, CLAMPED, IN UTC ────────────────────────────────────────
 * The new expiry is `expiryBefore` plus `months` calendar months in UTC, with
 * the time of day kept. A day that does not exist in the target month is
 * CLAMPED to that month's last day: 31 Jan + 1 month = 28 Feb (29 in a leap
 * year), 31 Mar + 1 = 30 Apr, 29 Feb 2028 + 12 = 28 Feb 2029. Clamped rather
 * than JavaScript's overflow (31 Jan + 1 → 3 Mar) because an overflow gives
 * days nobody paid for and can skip a whole month. Note that DMS's own
 * payment-verify renewal (`lib/services/payment/renewal.ts`) still uses the
 * overflowing `setUTCMonth`; the two disagree only when the day is 29-31.
 *
 * ─── A SUSPENDED ACCOUNT IS UNSUSPENDED THROUGH hosting.unsuspend ────────────
 * If the row is `suspended` or `expired`, the extension is written FIRST, then
 * the DirectAdmin account is unsuspended by calling the `hosting.unsuspend`
 * handler itself (one code path, not a copy), and only on its success is the
 * row set `active`. If the unsuspend fails, the renewal is still reported as
 * done — because it is — with `unsuspended: false` and the reason, so nobody
 * resends the renewal to "fix" it (that would be refused as already-extended
 * anyway) and the next step is named.
 *
 * Live only behind its own gate, `ENGINE_HOSTING_RENEW_LIVE=1`.
 */
import { serverLogger } from "@/lib/server-logger";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";
import { attemptProviderWrite } from "./engine-attempt";
import { HOLD_PREFIX } from "./engine-register-policy";
import { unsuspendHosting } from "./engine-handlers-hosting";

/**
 * Loaded lazily, for the reason the other handlers give: `lib/mongodb.ts`
 * throws at module load without its env, and a static import would make the
 * whole command registry un-importable.
 */
async function deps() {
  const [{ default: Hosting }, { default: connectDB }] = await Promise.all([
    import("@/models/Hosting"),
    import("@/lib/mongodb"),
  ]);
  return { Hosting, connectDB };
}

/** What the reconciler needs: the baseline, nothing about payment. */
interface HostingRenewBaseline {
  months: number;
  /** Epoch SECONDS, floored — what the caller computed from the ISO expiry. */
  expiryBefore: number;
}

interface HostingRenewRequest extends HostingRenewBaseline {
  paymentMode: "live" | "test";
  sourceRef: string | null;
}

/** Epoch seconds above this are almost certainly milliseconds (year 5138+). */
const LOOKS_LIKE_MILLISECONDS = 1e11;

function parseBaseline(payload: Record<string, unknown>): HostingRenewBaseline {
  const months = Number(payload.months);
  if (payload.months === undefined || payload.months === null || !Number.isInteger(months) || months < 1 || months > 36) {
    throw new Error(
      `"months" must be a whole number from 1 to 36 — how long the paid renewal is. Received ` +
        `${JSON.stringify(payload.months)}. Nothing was changed.`
    );
  }

  const expiryBefore = Number(payload.expiryBefore);
  if (payload.expiryBefore === undefined || payload.expiryBefore === null || !Number.isInteger(expiryBefore) || expiryBefore <= 0) {
    throw new Error(
      '"expiryBefore" is required: the hosting\'s CURRENT expiry as you observed it, in whole ' +
        "epoch seconds (Math.floor(Date.parse(expiryDate) / 1000) from the services lookup). It " +
        "is not optional and this command will not look it up for you — a freshly-read expiry " +
        "always matches, which is exactly how a retry would renew twice. Read it, then send " +
        `what you read. Received ${JSON.stringify(payload.expiryBefore)}. Nothing was changed.`
    );
  }
  if (expiryBefore > LOOKS_LIKE_MILLISECONDS) {
    throw new Error(
      `"expiryBefore" (${expiryBefore}) looks like MILLISECONDS; this command takes epoch ` +
        `SECONDS. Divide by 1000 and floor it. Nothing was changed.`
    );
  }
  return { months, expiryBefore };
}

function parseRequest(payload: Record<string, unknown>): HostingRenewRequest {
  const base = parseBaseline(payload);
  const paymentMode = payload.paymentMode;
  if (paymentMode !== "live" && paymentMode !== "test") {
    throw new Error(
      `"paymentMode" must be "live" or "test" — the paying side's Razorpay key mode. Received ` +
        `${JSON.stringify(paymentMode)}. Nothing was changed.`
    );
  }
  const sourceRef =
    typeof payload.sourceRef === "string" && payload.sourceRef.trim() ? payload.sourceRef.trim().slice(0, 80) : null;
  return { ...base, paymentMode, sourceRef };
}

/**
 * `date` + `months` calendar months in UTC, time of day kept, a missing day
 * clamped to the target month's last day. See the header for why clamped.
 */
export function addCalendarMonthsUtc(date: Date, months: number): Date {
  const monthIndex = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface HostingRow {
  _id: unknown;
  domainName: string;
  status: string;
  expiryDate: Date | null;
  directAdminUsername: string | null;
}

type Lookup =
  | { kind: "found"; row: HostingRow }
  | { kind: "none" }
  | { kind: "ambiguous"; ids: string[] };

/** The one non-terminated Hosting row for this domain — READS only. */
async function findHosting(domain: string): Promise<Lookup> {
  const { Hosting, connectDB } = await deps();
  await connectDB();
  const rows = await Hosting.find({
    domainName: { $regex: `^${escapeRegex(domain)}$`, $options: "i" },
    status: { $ne: "terminated" },
  })
    .select("_id domainName status expiryDate directAdminUsername")
    .lean<Array<{ _id: unknown; domainName: string; status: string; expiryDate?: Date | null; directAdminUsername?: string | null }>>();

  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "ambiguous", ids: rows.map((r) => String(r._id)) };
  const r = rows[0];
  return {
    kind: "found",
    row: {
      _id: r._id,
      domainName: r.domainName,
      status: String(r.status),
      expiryDate: r.expiryDate ? new Date(r.expiryDate) : null,
      directAdminUsername: r.directAdminUsername?.trim() || null,
    },
  };
}

function secondsOf(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

const NEEDS_UNSUSPEND = new Set(["suspended", "expired"]);

export const renewHostingCommand: CommandHandler = async (ctx): Promise<HandlerResult> => {
  // ── 1. The payload. ────────────────────────────────────────────────────────
  const req = parseRequest(ctx.payload);
  const domain = ctx.subject.trim().toLowerCase();

  // ── 2. Which hosting is this? ─────────────────────────────────────────────
  const lookup = await findHosting(domain);
  if (lookup.kind === "none") {
    throw new Error(
      `DMS has no hosting for ${domain} that is not terminated, so no renewal was recorded. ` +
        `Check the domain name against the services lookup, or renew it by hand in the DMS admin.`
    );
  }
  if (lookup.kind === "ambiguous") {
    throw new Error(
      `DMS has ${lookup.ids.length} hostings for ${domain} that are not terminated ` +
        `(${lookup.ids.join(", ")}), so it cannot tell which one was paid for. Nothing was changed. ` +
        `Terminate the stale one in the DMS admin, or extend the right one by hand.`
    );
  }
  const row = lookup.row;
  const hostingId = String(row._id);

  // ── 3. A test-mode payment settled no money: never renewed live. ──────────
  if (ctx.mode === "live" && req.paymentMode === "test") {
    throw new Error(
      `${HOLD_PREFIX} the renewal of ${domain} was paid through a TEST-mode Razorpay key, so no ` +
        `money settled. The expiry was not moved at any setting. Nothing was changed.`
    );
  }

  // ── 4. Is the world as the caller saw it? ─────────────────────────────────
  if (!row.expiryDate || Number.isNaN(row.expiryDate.getTime())) {
    throw new Error(
      `The DMS hosting for ${domain} (${hostingId}) has no expiry date, so the renewal cannot be ` +
        `checked against the one you sent. Nothing was changed. Set its expiry by hand in the DMS admin.`
    );
  }
  const current = secondsOf(row.expiryDate);
  if (current > req.expiryBefore) {
    throw new Error(
      `The hosting for ${domain} has already been extended since you read it: you sent ` +
        `expiryBefore=${req.expiryBefore} and DMS now says ${current} ` +
        `(${row.expiryDate.toISOString()}). Nothing was changed. If you mean another term on top ` +
        `of that one, send a new command with expiryBefore=${current} — deliberately.`
    );
  }
  if (current < req.expiryBefore) {
    throw new Error(
      `The hosting for ${domain}'s expiry in DMS (${current}, ${row.expiryDate.toISOString()}) is ` +
        `EARLIER than the ${req.expiryBefore} you sent. That is not a state this hosting has had, ` +
        `so the request is refused rather than guessed at. Nothing was changed. Re-read the ` +
        `services lookup and send what it says.`
    );
  }

  const expiryAfter = addCalendarMonthsUtc(new Date(req.expiryBefore * 1000), req.months);
  const wantsUnsuspend = NEEDS_UNSUSPEND.has(row.status);

  if (ctx.mode === "test") {
    return {
      result: {
        ok: true,
        dryRun: true,
        changed: false,
        hostingId,
        domain,
        status: row.status,
        expiryBefore: req.expiryBefore,
        expiryAfter: expiryAfter.toISOString(),
        months: req.months,
        unsuspended: false,
        wouldUnsuspend: wantsUnsuspend,
        wouldRenew: req.paymentMode === "live",
        hold:
          req.paymentMode === "live"
            ? null
            : `${HOLD_PREFIX} test-mode payment — a live run would not move the expiry`,
        sourceRef: req.sourceRef,
        note:
          "Test mode: the hosting row was READ and its expiry matched, and nothing was changed. " +
          "A live run would move the expiry" +
          (wantsUnsuspend ? " and unsuspend the DirectAdmin account." : "."),
      },
    };
  }

  // ── 5. Extend. Compare-and-set on the expiry just compared. ───────────────
  const { Hosting } = await deps();
  const nextActionAt = new Date(expiryAfter.getTime() - 15 * 24 * 60 * 60 * 1000);
  const write = await attemptProviderWrite(() =>
    Hosting.updateOne(
      { _id: row._id, expiryDate: row.expiryDate },
      /* Mirrors lib/services/payment/renewal.ts: the scheduler selects on
         next_action_at (expiry − 15 days) and the reminder ladder on
         last_reminder_sent, so both are reset with the expiry. */
      { $set: { expiryDate: expiryAfter, next_action_at: nextActionAt, last_reminder_sent: null } }
    )
  );
  if (write.matchedCount === 0) {
    throw new Error(
      `The hosting for ${domain} changed between being read and being written (another renewal ` +
        `or an admin edit), so nothing was changed. Re-read the services lookup and send the ` +
        `expiry it shows now.`
    );
  }
  serverLogger.warn(
    `[engine] RENEWED hosting ${domain} (${hostingId}) by ${req.months} month(s): ` +
      `${new Date(req.expiryBefore * 1000).toISOString()} -> ${expiryAfter.toISOString()}` +
      (req.sourceRef ? ` (${req.sourceRef})` : "")
  );

  // ── 6. A suspended account comes back, through hosting.unsuspend. ─────────
  let unsuspended = false;
  let unsuspendError: string | null = null;
  if (wantsUnsuspend) {
    if (!row.directAdminUsername) {
      unsuspendError =
        `The renewal is recorded, but the hosting was "${row.status}" and has no DirectAdmin ` +
        `username on its DMS row, so it could not be unsuspended. Find the account on the ` +
        `DirectAdmin server, unsuspend it there, and set this hosting active in the DMS admin.`;
    } else {
      try {
        await unsuspendHosting({
          commandId: ctx.commandId,
          subject: domain,
          mode: "live",
          payload: { username: row.directAdminUsername },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        unsuspendError =
          `The renewal is recorded, but unsuspending DirectAdmin account ` +
          `${row.directAdminUsername} failed: ${message}. The account may still be suspended. ` +
          `Send hosting.unsuspend for ${domain} with username ${row.directAdminUsername} (safe to ` +
          `repeat), then set this hosting active in the DMS admin. Do NOT resend hosting.renew — ` +
          `the term has already been added.`;
      }
      if (!unsuspendError) {
        unsuspended = true;
        try {
          await Hosting.updateOne({ _id: row._id }, { $set: { status: "active" } });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          unsuspendError =
            `The renewal is recorded and DirectAdmin account ${row.directAdminUsername} is ` +
            `unsuspended, but the DMS row could not be set active (${message}), so DMS still shows ` +
            `it as "${row.status}". Set it active in the DMS admin.`;
        }
      }
    }
    if (unsuspendError) serverLogger.error(`[engine] hosting.renew ${domain}: ${unsuspendError}`);
  }

  return {
    result: {
      ok: true,
      changed: true,
      hostingId,
      domain,
      expiryBefore: req.expiryBefore,
      expiryAfter: expiryAfter.toISOString(),
      months: req.months,
      unsuspended,
      /* Only when the row needed one and it did not fully happen. */
      unsuspendError,
      sourceRef: req.sourceRef,
    },
  };
};

/**
 * Reconciler: did the expiry move past what the caller sent? A pure read of
 * the same row the handler compared.
 */
export const reconcileHostingRenew: Reconciler = async (ctx): Promise<ReconcileVerdict> => {
  let req: HostingRenewBaseline;
  try {
    req = parseBaseline(ctx.request);
  } catch {
    return "unknown";
  }
  const lookup = await findHosting(ctx.subject.trim().toLowerCase());
  if (lookup.kind !== "found") return "unknown";
  const expiry = lookup.row.expiryDate;
  // An absent expiry is a missing answer, not a "no".
  if (!expiry || Number.isNaN(expiry.getTime())) return "unknown";
  const current = secondsOf(expiry);
  if (current > req.expiryBefore) return "done";
  if (current === req.expiryBefore) return "not_done";
  /* Earlier than the baseline: nothing sane produces that — ask a human. */
  return "unknown";
};
