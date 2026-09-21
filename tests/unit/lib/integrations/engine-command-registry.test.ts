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
  it("only the free or reversible commands are performable", () => {
    // Phase 6 added DNS and suspend/unsuspend (free: a record can be set back,
    // an account unsuspended). Phase 7 added change_plan, which is reversible
    // spend — a bigger package costs money and changing back undoes it.
    expect(Object.keys(HANDLERS).sort()).toEqual([
      "dns.record.upsert",
      "engine.selftest",
      "hosting.change_plan",
      "hosting.suspend",
      "hosting.unsuspend",
    ]);
  });

  it.each(["hosting.provision", "domain.renew", "domain.register"])(
    "%s still has NO handler",
    (c) => {
      // The day one of these gets a handler, this test fails and whoever added
      // it has to come here and say so. It did its job on 21 Sep: Phase 7
      // registered change_plan and this assertion is why that was a deliberate
      // edit rather than a silent one.
      //
      // `hosting.provision` is on this list for a DIFFERENT reason from the
      // other two. They spend an unrecoverable rupee. It is blocked on a
      // product decision — DMS mints a Math.random() password it never returns
      // because its customers arrive by SSO, so an engine-provisioned account
      // has no way in. Todos.md §D.
      expect(handlerFor(c as never)).toBeNull();
    }
  );

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
