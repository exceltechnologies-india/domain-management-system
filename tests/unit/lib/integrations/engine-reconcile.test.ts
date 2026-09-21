/**
 * Settling a command whose outcome is unknown.
 *
 * Threat model — the two wrong guesses cost different things, and both are
 * expensive:
 *  - **Guessing "not_done" and requeueing** re-runs work that may already have
 *    taken effect. On domain.register that is a second registration.
 *  - **Guessing "done"** closes a command that never happened, so the customer
 *    paid and got nothing, and nobody is looking any more.
 *  So `unknown` must stay `unknown`: an unreachable or ambiguous provider is
 *  not evidence, and the claim stays held.
 *  - **A reconciler must never throw out.** This is the recovery path; a
 *    recovery path that fails loudly leaves the operator with a stuck command
 *    AND an error instead of a clear next step.
 *  - **No real reconcilers may exist yet.** One written against an API nobody
 *    calls is a guess about a response shape, and a wrong guess settles
 *    commands incorrectly while looking authoritative.
 */
import { describe, it, expect } from "vitest";
import {
  reconcileCommand,
  reconcilerFor,
  statusForVerdict,
  RECONCILERS,
} from "@/lib/integrations/engine-reconcile";

const ctx = { subject: "example.com", request: {} };

describe("a reconciler exists only where the effect is observable", () => {
  it("exactly the Phase 6 commands have one", () => {
    // These three can be checked with a pure read: "does this record hold this
    // value", "is this account suspended". Adding a fourth means claiming its
    // effect is observable too — which is a decision, not a formality.
    expect(Object.keys(RECONCILERS).sort()).toEqual([
      "dns.record.upsert",
      "hosting.suspend",
      "hosting.unsuspend",
    ]);
  });

  it.each(["domain.register", "domain.renew", "hosting.provision"])(
    "%s has no reconciler — its command is not built yet",
    (c) => expect(reconcilerFor(c)).toBeNull()
  );

  it("a command with no reconciler is unknown, and says what to do instead", async () => {
    const r = await reconcileCommand("domain.register", ctx);
    expect(r.verdict).toBe("unknown");
    expect(r.detail).toMatch(/no automatic check/i);
    // CLAUDE.md §24 — not a bare "cannot".
    expect(r.detail).toMatch(/provider's console/i);
    expect(r.detail).toMatch(/resolve or requeue/i);
  });
});

describe("a reconciler's verdict is taken literally", () => {
  const withReconciler = async (
    fn: () => Promise<"done" | "not_done" | "unknown"> | never
  ) => {
    (RECONCILERS as Record<string, unknown>)["domain.register"] = fn;
    try {
      return await reconcileCommand("domain.register", ctx);
    } finally {
      delete (RECONCILERS as Record<string, unknown>)["domain.register"];
    }
  };

  it("done → done", async () => {
    const r = await withReconciler(async () => "done");
    expect(r.verdict).toBe("done");
    expect(r.detail).toMatch(/really did take effect/i);
  });

  it("not_done → not_done", async () => {
    const r = await withReconciler(async () => "not_done");
    expect(r.verdict).toBe("not_done");
    expect(r.detail).toMatch(/no record/i);
  });

  it("unknown stays unknown — it is not rounded to a decision", async () => {
    const r = await withReconciler(async () => "unknown");
    expect(r.verdict).toBe("unknown");
  });

  it("a THROWING reconciler becomes unknown, not a failure", async () => {
    // An unreachable provider says nothing about whether the work happened.
    const r = await withReconciler(async () => {
      throw new Error("ECONNRESET");
    });
    expect(r.verdict).toBe("unknown");
    expect(r.detail).toMatch(/could not reach the provider/i);
    expect(r.detail).toMatch(/ECONNRESET/);
  });
});

describe("statusForVerdict", () => {
  it("done → succeeded, not_done → failed", () => {
    expect(statusForVerdict("done")).toBe("succeeded");
    expect(statusForVerdict("not_done")).toBe("failed");
  });

  it("unknown → null, so nothing is settled", () => {
    // Returning a status here would turn "we still do not know" into a
    // decision, and release a claim on no evidence.
    expect(statusForVerdict("unknown")).toBeNull();
  });
});
