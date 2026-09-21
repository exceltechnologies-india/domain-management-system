/**
 * The first commands that touch a provider: hosting suspend and unsuspend.
 *
 * These go first because they are FREE and REVERSIBLE. Suspending an account
 * costs nothing and unsuspending puts it back; the worst outcome of a bug here
 * is a customer's site being down for as long as it takes to notice, which is
 * bad but recoverable. Domain registration — the one that cannot be undone and
 * spends money — is deliberately last, in Phase 9.
 *
 * ─── WHAT TEST MODE DOES ─────────────────────────────────────────────────────
 * It contacts nothing and changes nothing. It validates the request and READS
 * the current state so it can report what a live run would do — "the account
 * exists and is active; a live run would suspend it". That is worth having:
 * most of what goes wrong with a command is the request being wrong, and a dry
 * run catches that without touching anybody's hosting.
 *
 * A read against DirectAdmin is itself a provider call, so test mode is not
 * "offline" — it is "no writes". Said plainly here because "test mode does not
 * contact the provider" would be a comforting sentence and a false one.
 */
import {
  suspendUser,
  unsuspendUser,
  getUserConfig,
} from "@/lib/integrations/directadmin";
import { serverLogger } from "@/lib/server-logger";
import { attemptProviderWrite, providerRefused } from "./engine-attempt";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";

/** DirectAdmin reports suspension as a string flag on the user config. */
function isSuspended(config: Record<string, string | undefined>): boolean | null {
  const raw = config.suspended;
  if (raw === undefined) return null;
  return String(raw).toLowerCase() === "yes" || String(raw) === "1";
}

/**
 * Look up the account before doing anything to it.
 *
 * Shared by both handlers and both reconcilers, because "does this account
 * exist and what state is it in" is the same question every time — and asking
 * it in one place is what stops the two handlers drifting into disagreeing
 * about what `suspended` looks like on the wire.
 */
async function readState(username: string): Promise<
  | { ok: true; suspended: boolean | null }
  | { ok: false; reason: "not_found" | "unreachable"; detail: string }
> {
  const outcome = await getUserConfig({ username });
  if (outcome.kind === "found") {
    return { ok: true, suspended: isSuspended(outcome.config) };
  }
  if (outcome.kind === "user_not_found") {
    return {
      ok: false,
      reason: "not_found",
      detail: `DirectAdmin has no account called "${username}".`,
    };
  }
  return {
    ok: false,
    reason: "unreachable",
    detail: `Could not reach DirectAdmin to check "${username}": ${outcome.reason}`,
  };
}

function requireUsername(payload: Record<string, unknown>): string {
  const username = typeof payload.username === "string" ? payload.username.trim() : "";
  if (!username) {
    throw new Error(
      'This command needs a "username" in its payload — the DirectAdmin account to act on. ' +
        "The subject is the domain; the username is the account."
    );
  }
  return username;
}

export const suspendHosting: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const username = requireUsername(ctx.payload);
  const state = await readState(username);

  if (!state.ok) {
    /**
     * Thrown, not returned as a result. The route turns a throw into a failed
     * command with `transport: "not_sent"`, which is correct here: we never
     * issued a suspend, so nothing can have half-happened and the claim is
     * safe to release.
     */
    throw new Error(state.detail);
  }

  if (state.suspended === true) {
    /**
     * Already suspended is a SUCCESS, not an error. The caller asked for the
     * account to be suspended and it is. Failing here would make a retry —
     * the commonest reason to send the same command twice — look like a
     * problem, and would leave the operator wondering which of the two runs
     * was the real one.
     */
    return {
      result: {
        ok: true,
        username,
        changed: false,
        state: "suspended",
        note: "Already suspended; nothing to do.",
      },
    };
  }

  if (ctx.mode === "test") {
    return {
      result: {
        ok: true,
        username,
        changed: false,
        dryRun: true,
        wouldChange: "active -> suspended",
        note:
          "Test mode: the account was read but NOT changed. A live run would suspend it.",
      },
    };
  }

  /**
   * Wrapped: from here a request can leave for DirectAdmin. If it dies in
   * flight the error is branded `sent_unknown`, the claim is held and a human
   * reconciles — rather than the route assuming nothing happened.
   */
  const outcome = await attemptProviderWrite(() =>
    suspendUser({ username, reason: "ResellerOS engine command" })
  );
  if (outcome.kind !== "suspended") {
    // DA answered, and the answer was no. `responded`, not `sent_unknown`:
    // we KNOW it did not apply, so parking the subject would be pure toil.
    throw providerRefused(`DirectAdmin refused the suspend: ${outcome.kind}`);
  }
  serverLogger.warn(`[engine] suspended DirectAdmin account ${username}`);
  return {
    result: { ok: true, username, changed: true, state: "suspended" },
  };
};

export const unsuspendHosting: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const username = requireUsername(ctx.payload);
  const state = await readState(username);

  if (!state.ok) throw new Error(state.detail);

  if (state.suspended === false) {
    return {
      result: {
        ok: true,
        username,
        changed: false,
        state: "active",
        note: "Already active; nothing to do.",
      },
    };
  }

  if (ctx.mode === "test") {
    return {
      result: {
        ok: true,
        username,
        changed: false,
        dryRun: true,
        wouldChange: "suspended -> active",
        note:
          "Test mode: the account was read but NOT changed. A live run would unsuspend it.",
      },
    };
  }

  const outcome = await attemptProviderWrite(() => unsuspendUser({ username }));
  if (outcome.kind !== "unsuspended") {
    throw providerRefused(`DirectAdmin refused the unsuspend: ${outcome.kind}`);
  }
  serverLogger.warn(`[engine] unsuspended DirectAdmin account ${username}`);
  return { result: { ok: true, username, changed: true, state: "active" } };
};

/**
 * Reconcilers. Both are pure reads of the same state the handlers check.
 *
 * These are the first reconcilers to exist, and they can exist now precisely
 * because the question is answerable: "is this account suspended" has a
 * definite answer in DirectAdmin. A command whose effect cannot be observed
 * afterwards should NOT get a reconciler that guesses.
 */
function reconcilerFromDesiredState(desired: boolean): Reconciler {
  return async (ctx): Promise<ReconcileVerdict> => {
    const username =
      typeof ctx.request.username === "string" ? ctx.request.username.trim() : "";
    if (!username) return "unknown";

    const state = await readState(username);
    if (!state.ok) {
      /**
       * `not_found` is `unknown`, NOT `not_done`. A missing account means the
       * username is wrong or the account was deleted — neither tells us whether
       * the suspend we are asking about took effect, and calling it not_done
       * would free the subject on no evidence.
       */
      return "unknown";
    }
    if (state.suspended === null) return "unknown";
    return state.suspended === desired ? "done" : "not_done";
  };
}

export const reconcileSuspend = reconcilerFromDesiredState(true);
export const reconcileUnsuspend = reconcilerFromDesiredState(false);
