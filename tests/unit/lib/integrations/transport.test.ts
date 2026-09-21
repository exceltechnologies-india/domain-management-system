/**
 * Whether a request reached the other side, recorded structurally.
 *
 * Threat model — this exists to stop one specific expensive mistake:
 *  - **ECONNRESET / ETIMEDOUT must NOT read as safe.** A reset can arrive
 *    after the bytes were delivered and acted upon; a timeout only means we
 *    stopped waiting. Both are the case where the registrar may already have
 *    registered the domain, and a blind retry registers it twice. That money
 *    does not come back.
 *  - **`sentBefore` must dominate.** If the caller knows the send had not been
 *    attempted, no error code may override that into "maybe sent" — the
 *    caller's knowledge is the only reliable signal, and inferring it from an
 *    error code is the guesswork this module replaces.
 *  - **Unknown must be unsafe.** An error shape nobody anticipated has to fall
 *    to `sent_unknown`, not to `not_sent`.
 */
import { describe, it, expect } from "vitest";
import {
  classifyTransport,
  isSafeToRetry,
  describeTransport,
  type Transport,
} from "@/lib/integrations/transport";

const err = (code?: string) => Object.assign(new Error("boom"), code ? { code } : {});

describe("nothing sent yet — the caller's knowledge wins", () => {
  it.each([undefined, "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ANYTHING"])(
    "code %p still classifies as not_sent when sentBefore=false",
    (code) => {
      expect(classifyTransport(err(code as string | undefined), false)).toBe("not_sent");
    }
  );

  it("a param-build throw is not_sent, and is therefore safe to retry", () => {
    // The real case: `new URLSearchParams(...)` or a validation throw, before
    // the POST. The registrar has never heard of it.
    expect(classifyTransport(new TypeError("Cannot convert undefined"), false)).toBe("not_sent");
    expect(isSafeToRetry("not_sent")).toBe(true);
  });
});

describe("sent, and the connection never established → still safe", () => {
  it.each(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"])("%s → not_sent", (code) => {
    expect(classifyTransport(err(code), true)).toBe("not_sent");
  });
});

describe("sent, and the outcome is unknowable → NOT safe", () => {
  it.each(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "ERR_BAD_RESPONSE"])(
    "%s → sent_unknown",
    (code) => {
      expect(classifyTransport(err(code), true)).toBe("sent_unknown");
    }
  );

  it("ECONNRESET is the expensive one and must never be retryable", () => {
    // A reset after the bytes landed looks identical to one before. The
    // registrar may hold a completed registration.
    const t = classifyTransport(err("ECONNRESET"), true);
    expect(t).toBe("sent_unknown");
    expect(isSafeToRetry(t)).toBe(false);
  });

  it("an error with no code at all → sent_unknown, not not_sent", () => {
    expect(classifyTransport(new Error("???"), true)).toBe("sent_unknown");
  });

  it.each([null, undefined, "a string", 42, {}])("a non-Error %p → sent_unknown", (e) => {
    expect(classifyTransport(e, true)).toBe("sent_unknown");
  });
});

describe("isSafeToRetry", () => {
  it("only not_sent is safe", () => {
    const all: Transport[] = ["not_sent", "sent_unknown", "responded"];
    expect(all.filter(isSafeToRetry)).toEqual(["not_sent"]);
  });

  it("'responded' is not 'safe to retry' — the response decides, not this", () => {
    // A responded error might be retryable (rate limit) or not (domain taken).
    // That is the classifier's job in lib/integrations/resellerclub/classify.ts;
    // conflating the two is how a permanent failure gets retried forever.
    expect(isSafeToRetry("responded")).toBe(false);
  });
});

describe("describeTransport — the sentence a human reads", () => {
  it("not_sent says nothing changed", () => {
    expect(describeTransport("not_sent")).toMatch(/never sent|nothing changed/i);
  });

  it("sent_unknown warns before retrying, rather than just reporting failure", () => {
    const s = describeTransport("sent_unknown");
    expect(s).toMatch(/may have completed/i);
    expect(s).toMatch(/check before retrying/i);
  });

  it("every Transport has a distinct sentence", () => {
    const all: Transport[] = ["not_sent", "sent_unknown", "responded"];
    const said = all.map(describeTransport);
    expect(new Set(said).size).toBe(3);
    expect(said.every((s) => s.length > 0)).toBe(true);
  });
});
