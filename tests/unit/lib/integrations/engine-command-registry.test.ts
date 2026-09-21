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
  it("ONLY engine.selftest has a handler", () => {
    expect(Object.keys(HANDLERS)).toEqual(["engine.selftest"]);
  });

  it.each(
    KNOWN_COMMANDS.filter((c) => c !== "engine.selftest")
  )("%s has no handler — it must not be performable yet", (c) => {
    expect(handlerFor(c)).toBeNull();
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
