/**
 * Settling a command that may or may not have happened.
 *
 * `needs_reconciliation` means the request reached the provider and we do not
 * know what it did — the `sent_unknown` transport from Phase 1. The claim on
 * that subject is deliberately HELD (Phase 2), so nothing else can act on it
 * until somebody establishes the truth. This module is how that truth is
 * established.
 *
 * ─── READ, NEVER WRITE ───────────────────────────────────────────────────────
 * A reconciler asks the provider "is this done?" and nothing else. It must not
 * register, renew, provision, or undo. The command it is settling may already
 * have taken effect, so any write here risks being the second one — which is
 * the exact failure the held claim exists to prevent. A reconciler that writes
 * would make recovery the most dangerous operation in the system.
 *
 * ─── "I DO NOT KNOW" IS AN ANSWER, AND IT MUST NOT SETTLE ────────────────────
 * The provider being unreachable, or answering ambiguously, is not evidence of
 * anything. It resolves to `unknown`, the claim stays held, and a human is
 * still required. Treating it as "not done" and requeueing is how the same
 * domain gets registered twice; treating it as "done" is how a customer pays
 * for something they never got. Neither guess is cheaper than asking.
 */
import type { KnownCommand } from "./engine-command-registry";
import { reconcileDnsUpsert } from "./engine-handlers-dns";
import { reconcileSuspend, reconcileUnsuspend } from "./engine-handlers-hosting";
import { reconcileChangePlan } from "./engine-handlers-plan";
import { reconcileRenew } from "./engine-handlers-domain";
import { reconcileRegister } from "./engine-handlers-register";

export type ReconcileVerdict =
  /** The provider confirms the work exists. The command really did succeed. */
  | "done"
  /** The provider confirms it does not. Nothing happened; safe to try again. */
  | "not_done"
  /**
   * Could not establish either. Unreachable, ambiguous, or no reconciler for
   * this command. NOT a failure and NOT a success — the claim stays held.
   */
  | "unknown";

export interface ReconcileContext {
  subject: string;
  /** What the original command was asked to do, for a reconciler that needs it. */
  request: Record<string, unknown>;
}

export type Reconciler = (ctx: ReconcileContext) => Promise<ReconcileVerdict>;

/**
 * Deliberately empty of real providers.
 *
 * Each command's reconciler is built in the phase that builds the command, and
 * not before: a reconciler written against an API nobody calls yet is a guess
 * about a response shape, and a wrong guess here settles a command incorrectly
 * — which is worse than having no reconciler at all, because the wrong answer
 * looks authoritative.
 *
 * Until then every command reconciles to `unknown` and waits for a human, which
 * is the honest state.
 */
export const RECONCILERS: Partial<Record<KnownCommand, Reconciler>> = {
  /* Phase 6. These three can have reconcilers because their effect is
     OBSERVABLE afterwards as a pure read: "does this record hold this value",
     "is this account suspended". A command whose effect cannot be observed
     must NOT get a reconciler that guesses — see the header. */
  "dns.record.upsert": reconcileDnsUpsert,
  "hosting.suspend": reconcileSuspend,
  "hosting.unsuspend": reconcileUnsuspend,
  /* Phase 7. Observable as two reads — the DirectAdmin package and the DMS
     hosting row — and BOTH are checked, because both are the command's
     effect. */
  "hosting.change_plan": reconcileChangePlan,
  /* Phase 8. Observable because the command CARRIES its own baseline: the
     caller's `expiryBefore`. Moved past it means the renewal landed. That is
     what lets a money command be settled by reading instead of by a person. */
  "domain.renew": reconcileRenew,
  /* Phase 9. Observable as a pure read: is the domain in our reseller account,
     owned by this customer's ResellerClub id. */
  "domain.register": reconcileRegister,
};

export function reconcilerFor(command: string): Reconciler | null {
  return RECONCILERS[command as KnownCommand] ?? null;
}

/**
 * Ask the provider what happened.
 *
 * Never throws: this is the recovery path, and a recovery path that fails
 * loudly on a provider hiccup leaves the operator with a stuck command AND an
 * error, rather than a stuck command and a clear next step. A throw becomes
 * `unknown`, which is what it means.
 */
export async function reconcileCommand(
  command: string,
  ctx: ReconcileContext
): Promise<{ verdict: ReconcileVerdict; detail: string }> {
  const reconciler = reconcilerFor(command);
  if (!reconciler) {
    return {
      verdict: "unknown",
      detail:
        `There is no automatic check for "${command}" yet, so this cannot be settled from ` +
        `here. Look at the provider's console for ${ctx.subject} and resolve or requeue it ` +
        `by hand.`,
    };
  }

  try {
    const verdict = await reconciler(ctx);
    return {
      verdict,
      detail:
        verdict === "done"
          ? `The provider confirms ${ctx.subject} is done. The command really did take effect.`
          : verdict === "not_done"
            ? `The provider has no record of ${ctx.subject}. Nothing took effect.`
            : `The provider could not give a clear answer about ${ctx.subject}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: "unknown",
      detail: `Could not reach the provider to check ${ctx.subject}: ${message}`,
    };
  }
}

/**
 * What a verdict means for the command's stored status.
 *
 * `unknown` maps to null on purpose — there is no status to move to, because
 * nothing was learned. Returning a status for it would turn "we still do not
 * know" into a decision.
 */
export function statusForVerdict(
  verdict: ReconcileVerdict
): "succeeded" | "failed" | null {
  if (verdict === "done") return "succeeded";
  if (verdict === "not_done") return "failed";
  return null;
}
