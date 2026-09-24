/**
 * `mode` is required, has no default, and `live` cannot run in this build.
 *
 * Threat model:
 *  - **No default, in either direction.** Defaulting to "live" lets a caller
 *    that forgot the field spend real money. Defaulting to "test" is safe today
 *    and silently answers a question the caller was supposed to answer — so the
 *    day the default flips, every such caller changes behaviour without anyone
 *    editing them. An absent mode is therefore an error, not an assumption.
 *  - **`live` is refused in CODE, not by configuration.** There is no env var
 *    to set. If a test here starts passing because something made
 *    LIVE_COMMANDS_ENABLED configurable, that is the regression. **That
 *    tripwire is unchanged** — the per-command lists added below are code too,
 *    and the env-var version still belongs to the phase that carries two
 *    fail-closed gates and a per-row human release with it.
 *  - **503, not 403.** The caller's credentials are fine and it is allowed to
 *    ask for live; this engine is not ready to serve it. A 403 reads as "your
 *    key is wrong" and sends someone to rotate a perfectly good credential.
 *  - **The flag must not be the whole answer.** It was, when the only handler
 *    was a no-op. Four provider-touching handlers later, one boolean means the
 *    cheapest wrong action — flipping a constant — would enable
 *    `domain.register` along with everything else. Eligibility is per command,
 *    and for some commands the refusal stays true after live is switched on.
 *  - **Silence is "no".** A command in neither list is refused: one nobody has
 *    classified is one nobody has thought about.
 *
 * The 503 assertions moved from `checkMode` to `checkLiveAllowed` with the
 * behaviour — they are not retired. `checkMode` now validates shape only,
 * because the refusal depends on WHICH command and it cannot see one.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  checkMode,
  checkLiveAllowed,
  mayContactProvider,
  LIVE_COMMANDS_ENABLED,
  LIVE_ELIGIBLE_COMMANDS,
  LIVE_INELIGIBLE_REASONS,
  ENGINE_MODES,
  OWN_LIVE_GATES,
  ownGateOpen,
} from "@/lib/integrations/engine-mode";
import { KNOWN_COMMANDS, HANDLERS } from "@/lib/integrations/engine-command-registry";

describe("mode is required", () => {
  it.each([undefined, null, ""])("%p → 400, and says why there is no default", (raw) => {
    const r = checkMode(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/no default on purpose/i);
      // The message has to explain the choice, or the next person adds a default.
      expect(r.error).toMatch(/spend real money/i);
    }
  });

  it.each(["LIVE", "Test", "production", "prod", 1, true, {}, []])(
    "%p is not a mode → 400",
    (raw) => {
      const r = checkMode(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  );

  it("only two modes exist", () => {
    expect([...ENGINE_MODES]).toEqual(["test", "live"]);
  });
});

describe("checkMode validates SHAPE only", () => {
  it("returns test", () => {
    expect(checkMode("test")).toEqual({ ok: true, mode: "test" });
  });

  it("accepts the WORD live — refusing it is checkLiveAllowed's job now", () => {
    // Leaving a general refusal here made the SPECIFIC one unreachable: a live
    // domain.register answered "live is switched off in this build", and the
    // operator would conclude that waiting for live is enough. It is not.
    expect(checkMode("live")).toEqual({ ok: true, mode: "live" });
  });
});

describe("live is hard-disabled in this build", () => {
  it("LIVE_COMMANDS_ENABLED is false", () => {
    // The whole of this phase rests on this. If it is true, the command path can
    // spend money and every other test here is describing something else.
    expect(LIVE_COMMANDS_ENABLED).toBe(false);
  });

  it("an ELIGIBLE command still gets 503, not 403", () => {
    const r = checkLiveAllowed("live", "dns.record.upsert");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.status).not.toBe(403);
    }
  });

  it("the refusal tells the caller what to do instead", () => {
    const r = checkLiveAllowed("live", "dns.record.upsert");
    if (!r.ok) {
      expect(r.error).toMatch(/switched off in this build/i);
      expect(r.error).toMatch(/test/i);
      // And that turning it on is not a setting — so nobody hunts for a flag.
      expect(r.error).toMatch(/code change|deploy/i);
    }
  });

  it("test mode passes every known command through untouched", () => {
    for (const c of KNOWN_COMMANDS) {
      expect(checkLiveAllowed("test", c)).toEqual({ ok: true, mode: "test" });
    }
  });
});

describe("eligibility is per command, and the flag cannot reach some of them", () => {
  it.each(Object.keys(LIVE_INELIGIBLE_REASONS))(
    "%s is refused with a reason that survives live being switched on",
    (command) => {
      const r = checkLiveAllowed("live", command);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(503);
        // The sentence that matters: waiting is NOT enough for these.
        expect(r.error).toMatch(/turning live on would not change that/i);
      }
    }
  );

  describe("domain.register has its own fail-closed gate (Phase 9)", () => {
    const KEY = "ENGINE_DOMAIN_REGISTER_LIVE";
    const ORIG = process.env[KEY];
    afterEach(() => {
      if (ORIG === undefined) delete process.env[KEY];
      else process.env[KEY] = ORIG;
    });

    it("is refused live while the gate is unset, naming the gate", () => {
      delete process.env[KEY];
      const r = checkLiveAllowed("live", "domain.register");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(503);
        expect(r.error).toContain(KEY);
        expect(r.error).toMatch(/owner approves/i);
      }
      expect(mayContactProvider("live", "domain.register")).toBe(false);
    });

    it("only an exact 1 opens it", () => {
      for (const v of ["", "0", "true", "yes", " 1", "01"]) {
        process.env[KEY] = v;
        expect(ownGateOpen("domain.register"), JSON.stringify(v)).toBe(false);
      }
      process.env[KEY] = "1";
      expect(checkLiveAllowed("live", "domain.register").ok).toBe(true);
      expect(mayContactProvider("live", "domain.register")).toBe(true);
    });

    it("opening it puts NOTHING else live", () => {
      process.env[KEY] = "1";
      for (const c of ["dns.record.upsert", "hosting.suspend", "hosting.change_plan", "domain.renew"]) {
        expect(checkLiveAllowed("live", c).ok, c).toBe(false);
        expect(mayContactProvider("live", c), c).toBe(false);
      }
    });

    it("test mode never needs the gate", () => {
      delete process.env[KEY];
      expect(checkLiveAllowed("test", "domain.register").ok).toBe(true);
    });
  });

  it("an unclassified command is refused — silence is no", () => {
    const r = checkLiveAllowed("live", "something.nobody.listed");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.error).toMatch(/has not been classified/i);
    }
  });

  it("the two lists do not overlap", () => {
    expect(LIVE_ELIGIBLE_COMMANDS.filter((c) => c in LIVE_INELIGIBLE_REASONS)).toEqual([]);
  });

  /**
   * The forcing function. A handler added in a later phase cannot inherit a
   * default — whoever adds it has to come here and classify it, in writing.
   */
  it("EVERY known command is classified, exactly once", () => {
    const unclassified = KNOWN_COMMANDS.filter(
      (c) => !LIVE_ELIGIBLE_COMMANDS.includes(c) && !(c in LIVE_INELIGIBLE_REASONS) && !(c in OWN_LIVE_GATES)
    );
    // ...and exactly once: a command in two lists has two answers.
    for (const c of KNOWN_COMMANDS) {
      const n = [LIVE_ELIGIBLE_COMMANDS.includes(c), c in LIVE_INELIGIBLE_REASONS, c in OWN_LIVE_GATES].filter(Boolean).length;
      expect(n, c).toBeLessThanOrEqual(1);
    }
    expect(
      unclassified,
      `neither live-eligible nor explicitly refused, so nobody has decided whether these may ` +
        `run live: ${unclassified.join(", ")}`
    ).toEqual([]);
  });

  it("nothing is eligible that cannot actually be performed", () => {
    // An eligible command with no handler would pass this gate and then 501 —
    // a confusing order of answers, and a promise the engine cannot keep.
    expect(LIVE_ELIGIBLE_COMMANDS.filter((c) => !(c in HANDLERS))).toEqual([]);
  });
});

describe("mayContactProvider — nothing may, at this phase", () => {
  it("test mode never contacts a provider", () => {
    for (const c of KNOWN_COMMANDS) expect(mayContactProvider("test", c)).toBe(false);
  });

  it("live mode does not either, while live is disabled", () => {
    for (const c of KNOWN_COMMANDS) expect(mayContactProvider("live", c)).toBe(false);
  });

  it("no mode can reach a provider in this build", () => {
    // Stated as a single claim, because "can anything here spend money" is the
    // question this phase exists to answer NO to.
    expect(
      ENGINE_MODES.some((m) => KNOWN_COMMANDS.some((c) => mayContactProvider(m, c)))
    ).toBe(false);
  });

  it("an ineligible command could not reach a provider even if live were on", () => {
    // Reads the real lists rather than a copy, so this cannot pass by agreeing
    // with a stale duplicate of them.
    for (const command of Object.keys(LIVE_INELIGIBLE_REASONS)) {
      expect(LIVE_ELIGIBLE_COMMANDS).not.toContain(command);
    }
  });
});
