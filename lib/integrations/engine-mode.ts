/**
 * Which mode a command runs in, and why `live` cannot run yet.
 *
 * ─── REQUIRED, WITH NO DEFAULT ───────────────────────────────────────────────
 * `mode` is not optional and does not default. Both of the obvious defaults are
 * wrong in different ways:
 *
 *   defaulting to "live" — a caller that forgot the field spends real money;
 *   defaulting to "test" — safe, but it silently answers a question the caller
 *     was supposed to answer, and the day the default flips, every one of those
 *     callers changes behaviour without anyone editing them.
 *
 * So an absent mode is a validation error. The caller states what it intends,
 * every time. Same shape as AGENTS.md L63: a new action's author writes its own
 * mode, which puts the right question in front of them.
 *
 * ─── live IS HARD-DISABLED, NOT CONFIGURED OFF ───────────────────────────────
 * There is no env var, no flag, no database row that turns `live` on at this
 * phase. It is refused in code, so the only way to enable it is an edit,
 * a review and a deploy.
 *
 * That is deliberate and temporary. The point of this phase is to exercise the
 * whole caller path — auth, validation, the idempotency store, the subject
 * mutex, dispatch, completion — with no possibility that a mistake anywhere in
 * it spends a rupee. A config flag would have made "is live on?" a question
 * about the environment, answerable only by looking at a running system. A
 * constant makes it a question about the code.
 *
 * Phase 9 replaces this with two fail-closed env gates plus a per-row human
 * confirmation, at which point this constant goes. Until then, anything that
 * reads LIVE_COMMANDS_ENABLED and finds it true is reading a lie.
 */

export const ENGINE_MODES = ["test", "live"] as const;
export type EngineMode = (typeof ENGINE_MODES)[number];

/**
 * Whether a `live` command may run. FALSE, in code, at this phase.
 *
 * Do not turn this into an env var as a convenience. The env-var version is
 * Phase 9's job and carries two gates and a human confirmation with it; a
 * single flag added here would look like the same thing and be much weaker.
 */
export const LIVE_COMMANDS_ENABLED = false as boolean;

export type ModeCheck =
  | { ok: true; mode: EngineMode }
  | { ok: false; status: number; error: string };

/**
 * Validate the mode a caller asked for.
 *
 * Returns the refusal rather than throwing, so a route reads as a sequence of
 * gates instead of a try/catch — and so the message can say what to do next
 * (CLAUDE.md §24) rather than surfacing a generic 500.
 */
export function checkMode(raw: unknown): ModeCheck {
  if (raw === undefined || raw === null || raw === "") {
    return {
      ok: false,
      status: 400,
      error:
        'This command needs a "mode" of "test" or "live". It has no default on purpose: ' +
        "defaulting to live would let a forgotten field spend real money, and defaulting to " +
        "test would answer for you. Send the one you mean.",
    };
  }

  if (typeof raw !== "string" || !(ENGINE_MODES as readonly string[]).includes(raw)) {
    return {
      ok: false,
      status: 400,
      error: `"mode" must be exactly "test" or "live". Received ${JSON.stringify(raw)}.`,
    };
  }

  const mode = raw as EngineMode;

  if (mode === "live" && !LIVE_COMMANDS_ENABLED) {
    return {
      ok: false,
      /**
       * 503, not 403. The caller is allowed to ask for live and its credentials
       * are fine — this engine is not ready to serve it. 403 would read as
       * "your key is wrong" and send someone to rotate a perfectly good
       * credential.
       */
      status: 503,
      error:
        "Live commands are switched off in this build. Nothing here can spend money yet: the " +
        "command path is being exercised end to end in test mode first. Send mode:\"test\" to " +
        "use it now. Enabling live is a code change and a deploy, not a setting.",
    };
  }

  return { ok: true, mode };
}

/** True when a command in this mode is allowed to touch a real provider. */
export function mayContactProvider(mode: EngineMode): boolean {
  return mode === "live" && LIVE_COMMANDS_ENABLED;
}
