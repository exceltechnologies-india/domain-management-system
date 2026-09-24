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
 *
 * ─── AND THE FLAG IS NO LONGER THE WHOLE ANSWER ──────────────────────────────
 * It was, when one no-op handler existed. It is not now that four handlers
 * contact providers, so `LIVE_ELIGIBLE_COMMANDS` below decides WHICH commands
 * the flag may enable, and `LIVE_INELIGIBLE_REASONS` names the ones it must
 * never reach whatever it is set to. Still no env var: this is code, and
 * changing it is still an edit, a review and a deploy.
 */

export const ENGINE_MODES = ["test", "live"] as const;
export type EngineMode = (typeof ENGINE_MODES)[number];

/**
 * Whether a `live` command may run AT ALL. FALSE, in code, at this phase.
 *
 * Do not turn this into an env var as a convenience. The env-var version is
 * Phase 9's job and carries two gates and a human confirmation with it; a
 * single flag added here would look like the same thing and be much weaker.
 */
export const LIVE_COMMANDS_ENABLED = false as boolean;

/**
 * Which commands this flag is allowed to enable — and the drift that made this
 * list necessary.
 *
 * When `LIVE_COMMANDS_ENABLED` was written (Phase 4, commit 509a8ff) the only
 * registered handler was `engine.selftest`, which contacts nothing. One boolean
 * was a complete answer, because flipping it could not do anything. Phases 6
 * and 7 then added four handlers that DO contact providers, and the boolean did
 * not change — so the cheapest wrong action available today, flipping one
 * constant, would enable every command at once, including any added later.
 *
 * That is AGENTS.md L74 exactly: a default encoding "nothing can happen yet"
 * stopped being true when the code arrived, and nothing forced it to change.
 *
 * So eligibility is now per command, and the flag is necessary but NOT
 * sufficient. Flipping it enables this list and nothing else.
 */
export const LIVE_ELIGIBLE_COMMANDS: readonly string[] = [
  /**
   * Contacts nothing by construction. Live is meaningless for it, which is
   * exactly why it is here: it makes the live PATH provable without any
   * provider being involved in the proof.
   */
  "engine.selftest",
  /* Phase 6 — free and reversible. A record can be set back, an account
     unsuspended. */
  "dns.record.upsert",
  "hosting.suspend",
  "hosting.unsuspend",
  /* Phase 7 — reversible spend. The boundary of this list: it costs money on
     the DirectAdmin server, and changing the plan back undoes it. */
  "hosting.change_plan",
];

/**
 * The commands this flag must NEVER enable on its own, and why each one.
 *
 * These strings are the refusal the caller reads, so the reason lives in one
 * place instead of being restated in a message that can drift from it. A
 * command listed here is refused for live even when `LIVE_COMMANDS_ENABLED` is
 * true — the flag cannot reach it.
 *
 * `engine-mode.test.ts` asserts every known command sits in exactly one of the
 * two lists, so adding a handler in a later phase cannot quietly inherit a
 * default. Whoever adds it has to decide, here, in writing.
 */
export const LIVE_INELIGIBLE_REASONS: Readonly<Record<string, string>> = {
  "hosting.provision":
    "provisioning a hosting account is blocked on a product decision, not on a switch: DMS " +
    "mints a password it never returns because its customers arrive by SSO, so an " +
    "engine-provisioned account for somebody with no DMS portal user has no way in at all.",
  /**
   * The reason CHANGED on 23 Sep 2026 and the old one must not linger: it said
   * "nobody has yet established whether a second call adds a second year".
   * That was answered — it does, and `domain.renew` now defends against it by
   * requiring the caller's observed expiry and sending that verbatim, so a
   * double renewal is refused before any money moves.
   *
   * It stays ineligible for a DIFFERENT reason, stated plainly so nobody reads
   * the old one as still binding: nothing in this engine caps spending. The
   * ambiguity is gone; the absence of a spend control is not.
   */
  "domain.renew":
    "a renewal spends a rupee that does not come back, and this engine has no spend control at " +
    "all — nothing caps how many renewals a caller could trigger. The double-renewal risk is " +
    "handled (the command refuses unless the expiry you send still matches the registrar), so " +
    "what is missing is a limit, not a guard.",
};

/**
 * Commands with their OWN live gate, independent of `LIVE_COMMANDS_ENABLED`.
 *
 * `domain.register` (Phase 9, 24 Sep 2026). The owner decided registration is
 * automatic after payment, within a spend limit (ResellerOS Todos.md §0A,
 * decisions 21-24). It is NOT added to `LIVE_ELIGIBLE_COMMANDS`, because that
 * list shares one flag: flipping it for registration would also put DNS,
 * suspend and plan changes live. Instead it has its own env gate, and the gate
 * fails closed — only the exact string "1" opens it, so an empty, misspelled or
 * truthy-looking value keeps it shut (AGENTS.md L41).
 *
 * The two fail-closed gates the phase plan asked for are this one and the
 * paying side's own (`DOMAIN_REGISTRATION_LIVE` in ResellerOS). The plan's
 * per-row human release was replaced by the owner with the spend limit in
 * engine-register-policy.ts: live payment, cost covered, daily count + ₹ cap;
 * anything outside it is HELD for a person.
 */
export const OWN_LIVE_GATES: Readonly<Record<string, string>> = {
  "domain.register": "ENGINE_DOMAIN_REGISTER_LIVE",
};

/** True only when the command's own gate is set to exactly "1". */
export function ownGateOpen(command: string, env: Record<string, string | undefined> = process.env): boolean {
  const name = OWN_LIVE_GATES[command];
  return !!name && env[name] === "1";
}

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

  /**
   * SHAPE ONLY. The live refusal used to live here and has moved to
   * `checkLiveAllowed`, because this function cannot see the command and the
   * refusal now depends on it.
   *
   * Leaving a general refusal here would have made the specific one
   * unreachable: `domain.register` with mode:"live" would answer "live is
   * switched off in this build", and the operator would conclude that waiting
   * for live is enough. It is not, and that is the sentence worth getting
   * right.
   */
  return { ok: true, mode: raw as EngineMode };
}

/**
 * May THIS command run live, assuming live is on at all?
 *
 * Separate from `checkMode` because it answers a different question and needs
 * something `checkMode` does not have: the command name. The route calls it
 * after the command has been recognised, so a typo is still a 400 naming the
 * typo rather than a 503 about eligibility.
 *
 * Checked BEFORE the global flag on purpose (AGENTS.md L12 — the specific
 * before the general). "This command is permanently ineligible" is the durable
 * answer and stays true after live is switched on; "live is off in this build"
 * is temporary, and hearing it about `domain.register` would tell the operator
 * that waiting is enough. It is not.
 */
export function checkLiveAllowed(mode: EngineMode, command: string): ModeCheck {
  if (mode !== "live") return { ok: true, mode };

  const ineligible = LIVE_INELIGIBLE_REASONS[command];
  if (ineligible) {
    return {
      ok: false,
      status: 503,
      error:
        `"${command}" cannot run live, and turning live on would not change that — ${ineligible} ` +
        `Send mode:"test" to exercise the path, and do the work by hand in the provider's ` +
        `console until its own phase builds the gates it needs.`,
    };
  }

  const ownGate = OWN_LIVE_GATES[command];
  if (ownGate) {
    if (ownGateOpen(command)) return { ok: true, mode };
    return {
      ok: false,
      status: 503,
      error:
        `"${command}" can run live only when ${ownGate}=1 is set on this engine, and it is not. ` +
        `That switch is off until the owner approves the first real run. Nothing was recorded. ` +
        `Send mode:"test" to see exactly what a live run would do.`,
    };
  }

  if (!LIVE_ELIGIBLE_COMMANDS.includes(command)) {
    /**
     * Neither eligible nor explicitly refused. Fail closed and say so plainly:
     * a command nobody has classified is a command nobody has thought about,
     * and the safe reading of silence is "no".
     */
    return {
      ok: false,
      status: 503,
      error:
        `"${command}" has not been classified for live running, so it is refused. That is a gap ` +
        `in this engine rather than something you did wrong — every command has to be listed as ` +
        `eligible or refused, with a reason, before it can run live.`,
    };
  }

  if (!LIVE_COMMANDS_ENABLED) {
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
        `"${command}" is allowed to run live, but live commands are switched off in this build. ` +
        `Nothing here can spend money yet: the command path is being exercised end to end in ` +
        `test mode first. Send mode:"test" to use it now. Enabling live is a code change and a ` +
        `deploy, not a setting.`,
    };
  }

  return { ok: true, mode };
}

/**
 * True when a command in this mode is allowed to touch a real provider.
 *
 * Takes the command because the flag alone is no longer the answer — the whole
 * point of the eligibility list is that "live is on" and "this command may run
 * live" are different questions.
 */
export function mayContactProvider(mode: EngineMode, command: string): boolean {
  if (mode !== "live") return false;
  if (OWN_LIVE_GATES[command]) return ownGateOpen(command);
  return (
    LIVE_COMMANDS_ENABLED &&
    !LIVE_INELIGIBLE_REASONS[command] &&
    LIVE_ELIGIBLE_COMMANDS.includes(command)
  );
}
