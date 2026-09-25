/**
 * Which commands exist, and which can actually be performed.
 *
 * Threat model:
 *  - **Only `engine.selftest` may have a handler at this phase.** Every other
 *    entry names something that spends money or changes a customer's
 *    infrastructure. If one of them acquires a handler here, it became
 *    performable without going through the phase that was supposed to build its
 *    guards — so this test fails on that, deliberately, and whoever adds the
 *    handler has to come here and say so.
 *  - **Known-but-unimplemented and unknown are different answers.** Collapsing
 *    them makes a not-yet-built feature indistinguishable from a typo, and the
 *    caller goes looking in the wrong place.
 */
import { describe, it, expect } from "vitest";
import {
  KNOWN_COMMANDS,
  isKnownCommand,
  handlerFor,
  HANDLERS,
} from "@/lib/integrations/engine-command-registry";

describe("the contract's command names", () => {
  it("recognises every known command", () => {
    for (const c of KNOWN_COMMANDS) expect(isKnownCommand(c)).toBe(true);
  });

  it.each(["domain.teleport", "", "DOMAIN.REGISTER", "hosting.delete"])(
    "%p is not a known command",
    (c) => expect(isKnownCommand(c)).toBe(false)
  );

  it("names the commands that will spend money, even though none work yet", () => {
    // Listing them before building them is what lets the route answer 501
    // ("not yet") instead of 400 ("no such thing").
    for (const c of ["domain.register", "domain.renew", "hosting.provision"]) {
      expect(KNOWN_COMMANDS).toContain(c);
    }
  });
});

describe("what can actually be performed", () => {
  it("the performable set, and what each addition cost in guarantees", () => {
    // Phase 6: free (a record can be set back, an account unsuspended).
    // Phase 7: reversible spend (a bigger package costs money; changing back
    //   undoes it).
    // Phase 8: domain.renew, which is NEITHER — the rupee does not come back.
    //   It is performable because its ambiguity is resolvable by a pure read,
    //   not because it is safe. Being here is not the same as being allowed to
    //   run live; engine-mode.ts decides that — since 25 Sep 2026 only behind
    //   ENGINE_DOMAIN_RENEW_LIVE=1 and the same spend limit as domain.register.
    // Phase 9 (24 Sep 2026): domain.register, which cannot be undone at all.
    //   Performable, and live ONLY behind its own gate
    //   (ENGINE_DOMAIN_REGISTER_LIVE=1) and the spend limit in
    //   engine-register-policy.ts. This tripwire is why that was a deliberate edit.
    // 25 Sep 2026: hosting.renew — records a renewal ResellerOS was paid for.
    //   Spends nothing; live only behind ENGINE_HOSTING_RENEW_LIVE=1.
    expect(Object.keys(HANDLERS).sort()).toEqual([
      "dns.record.upsert",
      "domain.register",
      "domain.renew",
      "engine.selftest",
      "hosting.change_plan",
      "hosting.provision",
      "hosting.renew",
      "hosting.suspend",
      "hosting.unsuspend",
    ]);
  });

  it("every known command is now performable — the two irreversible ones behind their own gates", () => {
    // 24 Sep 2026: domain.register and hosting.provision got handlers. What
    // keeps them from running is engine-mode.ts OWN_LIVE_GATES, not an absence.
    for (const c of KNOWN_COMMANDS) expect(handlerFor(c), c).not.toBeNull();
  });

  it("the selftest handler contacts nothing and says so", async () => {
    const h = handlerFor("engine.selftest");
    expect(h).not.toBeNull();
    const { result } = await h!({
      commandId: "c1",
      subject: "s1",
      mode: "test",
      payload: { a: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.echoed).toEqual({ a: 1 });
    // The note matters: a green run of this proves the plumbing and nothing
    // else, and must not be mistaken for proof that a provider call works.
    expect(String(result.note)).toMatch(/performs no work|contacts no provider/i);
  });
});
