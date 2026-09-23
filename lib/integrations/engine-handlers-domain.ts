/**
 * `domain.renew` — Phase 8. The first rupee that does not come back.
 *
 * Phases 6 and 7 were free or reversible: a DNS record can be set back, a
 * suspended account unsuspended, a plan changed down again. A renewal cannot be
 * undone. The registry has the money and the domain has the year.
 *
 * ─── THE QUESTION THAT GATED THIS PHASE, AND ITS ANSWER ──────────────────────
 * "Is a renewal idempotent at ResellerClub, or does a second call add a year?"
 * was recorded as not determinable from either codebase. It was determinable
 * from this one, and the answer is that AS WE CALLED IT, a retry bought a
 * second year:
 *
 * RC's `renew.json` requires `exp-date`, documented as the order's CURRENT
 * expiry. That is an optimistic-concurrency guard — send a stale value and you
 * lose. But `resellerclub-wrapper.ts` re-reads the expiry immediately before
 * every call and sends whatever it just read, so a retry after an
 * unacknowledged renewal reads the NEW expiry, sends that, it matches, and the
 * registrar renews again. The vendor's guard was being handed a valid answer by
 * our own pre-flight.
 *
 * ─── SO THIS COMMAND USES exp-date AS AN IDEMPOTENCY KEY ─────────────────────
 * `expiryBefore` is REQUIRED in the payload and is the expiry the CALLER
 * observed. This handler does not invent it, and deliberately does not re-read
 * it and use that instead — re-reading is precisely the bug above.
 *
 * It reads the current expiry only to COMPARE:
 *
 *   current == expiryBefore  → the world is as the caller saw it. Proceed.
 *   current >  expiryBefore  → somebody already renewed it. REFUSE, spend
 *                              nothing, and say so. This is the double-renewal
 *                              being caught rather than committed.
 *   current <  expiryBefore  → the caller's view is not one this domain has
 *                              ever had. Refuse; something is wrong upstream.
 *
 * ─── AND IT MAKES THE AMBIGUOUS CASE RESOLVABLE ──────────────────────────────
 * The same field is the reconciler. If a response is lost, re-read the expiry:
 * moved past `expiryBefore` means the renewal landed, unchanged means it did
 * not. A pure read with a definite answer — the bar Phase 6 set for giving a
 * command a reconciler — which is why this does not need the per-row human
 * release the phase plan assumed.
 */
import { serverLogger } from "@/lib/server-logger";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";
import { attemptProviderWrite, brandTransport } from "./engine-attempt";
import type { Transport } from "./transport";

/**
 * ResellerClub and the Domain service are loaded lazily, for the reason the
 * DNS and plan handlers give: `lib/resellerclub/client.ts` and `lib/mongodb.ts`
 * both THROW at module load without their env, and a static import here would
 * make the whole command registry un-importable.
 */
async function deps() {
  const [{ getDomainOrderId, getDomainDetails }, { ResellerClubAPI }, { applyDomainRenewal }] =
    await Promise.all([
      import("@/lib/integrations/resellerclub"),
      import("@/lib/resellerclub"),
      import("@/lib/services/domains"),
    ]);
  return { getDomainOrderId, getDomainDetails, ResellerClubAPI, applyDomainRenewal };
}

interface RenewRequest {
  years: number;
  /** Epoch SECONDS, the unit RC's `orders.endtime` uses. */
  expiryBefore: number;
}

function parseRenew(payload: Record<string, unknown>): RenewRequest {
  const years = Number(payload.years);
  if (!Number.isInteger(years) || years < 1 || years > 10) {
    throw new Error(
      `"years" must be a whole number from 1 to 10 (ResellerClub's cap). Received ` +
        `${JSON.stringify(payload.years)}.`
    );
  }

  const expiryBefore = Number(payload.expiryBefore);
  if (!Number.isFinite(expiryBefore) || expiryBefore <= 0) {
    throw new Error(
      '"expiryBefore" is required: the domain\'s CURRENT expiry as you observed it, in epoch ' +
        "seconds. It is not optional and this command will not look it up for you — sending a " +
        "freshly-read expiry is exactly how a retry buys a second year, because it satisfies " +
        "the registrar's own staleness check. Read it, then send what you read."
    );
  }
  return { years, expiryBefore };
}

/** RC returns `orders.endtime` / `endtime` as epoch seconds, in a string. */
function readEndtime(details: Record<string, unknown>): number | null {
  const raw = details.endtime ?? details["orders.endtime"];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const renewDomainCommand: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const req = parseRenew(ctx.payload);
  const domain = ctx.subject;
  const { getDomainOrderId, getDomainDetails, ResellerClubAPI, applyDomainRenewal } = await deps();

  // ── 1. Which order is this domain? Read; spends nothing. ──────────────────
  const order = await getDomainOrderId({ domainName: domain });
  if (order.kind !== "found") {
    throw new Error(
      order.kind === "not_found"
        ? `ResellerClub has no order for ${domain}. Is the domain in this reseller account?`
        : `Could not resolve the ResellerClub order for ${domain}: ${order.reason}`
    );
  }

  // ── 2. Is the world as the caller saw it? ─────────────────────────────────
  const details = await getDomainDetails({ domainName: domain });
  if (details.kind !== "found") {
    throw new Error(
      `Could not read ${domain} at ResellerClub to confirm its current expiry, so nothing was ` +
        `renewed: ${details.kind === "not_found" ? details.reason : details.reason}`
    );
  }
  const current = readEndtime(details.details as Record<string, unknown>);
  if (current === null) {
    throw new Error(
      `ResellerClub did not return a usable expiry for ${domain}, so the renewal cannot be ` +
        `checked against the one you sent. Nothing was spent.`
    );
  }

  if (current > req.expiryBefore) {
    /**
     * The whole point of the phase. Somebody — another run of this command, the
     * customer panel, a person in the registrar console — has already renewed
     * since the caller looked. Renewing now would buy a year nobody asked for,
     * and it is caught here, before any money moves.
     */
    throw new Error(
      `${domain} has already been renewed since you read it: you sent expiry ${req.expiryBefore} ` +
        `and ResellerClub now says ${current}. Nothing was spent. If you still want another ` +
        `year, send a new command with expiryBefore=${current} — deliberately, because that is ` +
        `a second year on top of the one that just landed.`
    );
  }
  if (current < req.expiryBefore) {
    throw new Error(
      `${domain}'s expiry at ResellerClub (${current}) is EARLIER than the ${req.expiryBefore} ` +
        `you sent. That is not a state this domain has had, so the request is refused rather ` +
        `than guessed at. Nothing was spent.`
    );
  }

  if (ctx.mode === "test") {
    return {
      result: {
        ok: true,
        domain,
        years: req.years,
        orderId: order.orderId,
        expiryBefore: req.expiryBefore,
        changed: false,
        dryRun: true,
        note:
          "Test mode: the order and the current expiry were READ and matched, and nothing was " +
          "renewed. A live run would extend this domain and spend money that does not come back.",
      },
    };
  }

  // ── 3. Spend. `expiryBefore` is sent verbatim — never a fresh read. ───────
  const res = await attemptProviderWrite(() =>
    ResellerClubAPI.renewDomain(order.orderId, req.years, req.expiryBefore)
  );

  if (res.status === "error") {
    /**
     * The raw call already classifies its own transport (it tracks whether the
     * POST was attempted), so that answer is carried through rather than
     * re-derived. A renewal that MAY have landed must hold its claim.
     */
    const transport = (res as { transport?: Transport }).transport ?? "sent_unknown";
    throw brandTransport(
      new Error(
        `ResellerClub refused or lost the renewal of ${domain}: ${res.message ?? "no reason given"}`
      ),
      transport
    );
  }

  /**
   * Record the new expiry in the canonical place, for the same reason the
   * customer-facing route does: `daily-scheduler` selects on `next_action_at`,
   * derived from `expiresAt`, so a renewed domain that keeps its old row goes
   * on being chased to renew. Read back from RC rather than computed — a
   * renewal extends the CURRENT expiry, so `now + years` is wrong by whatever
   * was left.
   */
  let recordedExpiry: number | null = null;
  const after = await getDomainDetails({ domainName: domain });
  if (after.kind === "found") recordedExpiry = readEndtime(after.details as Record<string, unknown>);

  if (recordedExpiry && recordedExpiry > req.expiryBefore) {
    await applyDomainRenewal({ domainName: domain, newExpiresAt: new Date(recordedExpiry * 1000) });
  } else {
    serverLogger.error(
      `[engine] ${domain} was renewed at ResellerClub but its new expiry could not be read back ` +
        `(${after.kind}), so the DMS row still shows the old date and renewal reminders may ` +
        `fire. The renewal itself is done — do not send this command again.`
    );
  }

  serverLogger.warn(
    `[engine] RENEWED ${domain} for ${req.years} year(s) — order ${order.orderId}, expiry ` +
      `${req.expiryBefore} -> ${recordedExpiry ?? "unread"}`
  );
  return {
    result: {
      ok: true,
      domain,
      years: req.years,
      orderId: order.orderId,
      expiryBefore: req.expiryBefore,
      expiryAfter: recordedExpiry,
      changed: true,
      recorded: Boolean(recordedExpiry && recordedExpiry > req.expiryBefore),
    },
  };
};

/**
 * Reconciler: did the expiry move past what the caller sent?
 *
 * This is why `expiryBefore` is required rather than convenient. It is an exact
 * baseline captured before the spend, so the question "did my renewal land"
 * becomes a pure read with a definite answer instead of a judgement call — and
 * a command whose ambiguity can be resolved by reading does not need a human
 * parked in front of it.
 */
export const reconcileRenew: Reconciler = async (ctx): Promise<ReconcileVerdict> => {
  let req: RenewRequest;
  try {
    req = parseRenew(ctx.request);
  } catch {
    return "unknown";
  }

  const { getDomainDetails } = await deps();
  const details = await getDomainDetails({ domainName: ctx.subject });
  if (details.kind !== "found") return "unknown";

  const current = readEndtime(details.details as Record<string, unknown>);
  // An absent expiry is a missing answer, not a "no".
  if (current === null) return "unknown";

  if (current > req.expiryBefore) return "done";
  if (current === req.expiryBefore) return "not_done";
  /**
   * Earlier than the baseline. Nothing sane produces that, so it is reported as
   * unknown rather than forced into one of the two answers — settling a money
   * command on a reading that makes no sense is worse than asking a human.
   */
  return "unknown";
};
