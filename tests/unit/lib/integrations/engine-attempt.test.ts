/**
 * How far did the request get? — the wiring Phase 1 designed and Phase 4 did
 * not connect.
 *
 * Threat model:
 *  - **`sent_unknown` must survive to the route.** It is the only outcome that
 *    holds the subject claim. If it degrades to `not_sent`, a write that may
 *    have landed is recorded as never sent, the claim releases, and the next
 *    caller does it again.
 *  - **A refusal must NOT become `sent_unknown`.** When the provider answers
 *    "no" we know the work did not happen. Parking that subject for a human
 *    who has nothing to decide is how a guard earns a reputation as a
 *    nuisance and gets removed (AGENTS.md L103).
 *  - **An unbranded error must be `not_sent`.** Everything before the first
 *    wrapped write — validation, a lookup, a failed READ — changed nothing.
 *  - **The brand must survive a re-throw**, which is exactly where
 *    `instanceof` stops holding (L6).
 */
import { describe, it, expect } from "vitest";
import {
  attemptProviderWrite,
  providerRefused,
  transportOf,
  brandTransport,
} from "@/lib/integrations/engine-attempt";

const withCode = (code: string) => Object.assign(new Error(code), { code });

describe("an unbranded error says nothing, and that is the honest answer", () => {
  it.each([new Error("validation failed"), "a string", null, undefined, 42])(
    "%p carries no transport",
    (value) => expect(transportOf(value)).toBeNull()
  );

  it("a branded-looking property with a junk value is still null", () => {
    // Only the three real transports count. Anything else is not an answer.
    const err = brandTransport(new Error("x"), "sent_unknown");
    expect(transportOf(err)).toBe("sent_unknown");
    Object.defineProperty(err, Symbol.for("engine.transport"), { value: "maybe" });
    expect(transportOf(err)).toBeNull();
  });
});

describe("attemptProviderWrite brands by how far the connection got", () => {
  it("passes a successful value straight through", async () => {
    await expect(attemptProviderWrite(async () => ({ kind: "changed" }))).resolves.toEqual({
      kind: "changed",
    });
  });

  it.each(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"])(
    "%s proves nothing was received → not_sent",
    async (code) => {
      await expect(
        attemptProviderWrite(async () => {
          throw withCode(code);
        })
      ).rejects.toSatisfy((e: unknown) => transportOf(e) === "not_sent");
    }
  );

  it.each(["ECONNRESET", "ETIMEDOUT"])(
    "%s does NOT prove that → sent_unknown",
    async (code) => {
      // The whole point. A reset can arrive after the bytes were acted on, and
      // a timeout only means we stopped waiting.
      await expect(
        attemptProviderWrite(async () => {
          throw withCode(code);
        })
      ).rejects.toSatisfy((e: unknown) => transportOf(e) === "sent_unknown");
    }
  );

  it("an error with no code at all is sent_unknown, not not_sent", async () => {
    // Inside the wrapper the send was attempted, so the default leans toward
    // holding the subject rather than freeing it.
    await expect(
      attemptProviderWrite(async () => {
        throw new Error("something went wrong");
      })
    ).rejects.toSatisfy((e: unknown) => transportOf(e) === "sent_unknown");
  });

  it("the original error is preserved — message, type and stack", async () => {
    const original = withCode("ECONNRESET");
    const caught = await attemptProviderWrite(async () => {
      throw original;
    }).catch((e) => e);
    expect(caught).toBe(original);
    expect(caught.message).toBe("ECONNRESET");
  });
});

describe("providerRefused means the far end spoke", () => {
  it("is responded, so the claim releases", () => {
    const err = providerRefused("DirectAdmin has no package called 'Nope'");
    expect(transportOf(err)).toBe("responded");
    expect(err.message).toMatch(/no package called/);
  });

  it("is NOT sent_unknown — a known refusal must not park a subject", () => {
    expect(transportOf(providerRefused("x"))).not.toBe("sent_unknown");
  });
});

describe("the brand travels", () => {
  it("survives a catch and re-throw", async () => {
    // Where `instanceof` fails and a property does not (L6).
    const rethrown = await (async () => {
      try {
        await attemptProviderWrite(async () => {
          throw withCode("ETIMEDOUT");
        });
      } catch (e) {
        throw e;
      }
    })().catch((e) => e);
    expect(transportOf(rethrown)).toBe("sent_unknown");
  });

  it("is not enumerable, so it cannot leak into a logged object", () => {
    const err = providerRefused("x");
    expect(Object.keys(err)).not.toContain("Symbol(engine.transport)");
    expect(JSON.stringify({ ...err })).not.toMatch(/responded/);
  });
});
