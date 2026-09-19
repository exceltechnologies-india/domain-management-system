/**
 * Tests for `@/lib/integrations/engine-auth` — the door to the Engine API.
 *
 * The first block pins the same properties as `cron-auth.test.ts`, because the
 * same class of mistake applies: fail closed on a missing env, never throw on a
 * malformed header, constant-time compare.
 *
 * The second block is the one that earns its keep. The three-key split only
 * means anything if a weaker key cannot open a stronger door AND a stronger key
 * cannot open a weaker one. The tempting "optimisation" — let the command key
 * satisfy a read check, since anyone who can register a domain can obviously
 * read one — collapses three keys back into one, and does it invisibly. These
 * tests fail if someone makes that change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  authorizeEngineReadRequest,
  authorizeEngineCommandRequest,
} from "@/lib/integrations/engine-auth";

const READ_KEY = "read-key-0000000000000000";
const COMMAND_KEY = "command-key-000000000000";

function reqWith(header?: string): { headers: Headers } {
  const headers = new Headers();
  if (header !== undefined) headers.set("x-integration-key", header);
  return { headers };
}

beforeEach(() => {
  vi.stubEnv("ENGINE_READ_API_KEY", READ_KEY);
  vi.stubEnv("BILLING_COMMAND_API_KEY", COMMAND_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fails closed", () => {
  it("ENGINE_READ_API_KEY unset → false, even with a header present", () => {
    vi.stubEnv("ENGINE_READ_API_KEY", "");
    expect(authorizeEngineReadRequest(reqWith(READ_KEY) as never)).toBe(false);
  });

  it("BILLING_COMMAND_API_KEY unset → false", () => {
    vi.stubEnv("BILLING_COMMAND_API_KEY", "");
    expect(authorizeEngineCommandRequest(reqWith(COMMAND_KEY) as never)).toBe(false);
  });

  it("missing header → false, never a throw", () => {
    expect(() => authorizeEngineReadRequest(reqWith() as never)).not.toThrow();
    expect(authorizeEngineReadRequest(reqWith() as never)).toBe(false);
  });

  it("length mismatch → false, short-circuited before timingSafeEqual", () => {
    expect(authorizeEngineReadRequest(reqWith("short") as never)).toBe(false);
  });

  it("wrong key of EQUAL length → false", () => {
    const wrong = "x".repeat(READ_KEY.length);
    expect(wrong.length).toBe(READ_KEY.length);
    expect(authorizeEngineReadRequest(reqWith(wrong) as never)).toBe(false);
  });

  it("a header value a real Headers object could never hold → false, not a 500", () => {
    /* Deliberately NOT built with `new Headers()`: that constructor throws on
       any byte above 255, so the non-ASCII case cannot reach this function
       through the normal request path at all. The try/catch in the helper is
       defending against a value arriving some other way — a mocked request in a
       test, a future framework change — and this stub is the only way to prove
       the guard holds rather than leaving it as untested dead code. */
    const lonesomeSurrogate = { headers: { get: () => "\uD800".repeat(READ_KEY.length) } };
    expect(() => authorizeEngineReadRequest(lonesomeSurrogate as never)).not.toThrow();
    expect(authorizeEngineReadRequest(lonesomeSurrogate as never)).toBe(false);
  });
});

describe("the keys open only their own door", () => {
  it("the read key authorises a read", () => {
    expect(authorizeEngineReadRequest(reqWith(READ_KEY) as never)).toBe(true);
  });

  it("the command key authorises a command", () => {
    expect(authorizeEngineCommandRequest(reqWith(COMMAND_KEY) as never)).toBe(true);
  });

  it("the READ key cannot authorise a command — this is the whole point", () => {
    expect(authorizeEngineCommandRequest(reqWith(READ_KEY) as never)).toBe(false);
  });

  it("the COMMAND key cannot authorise a read, however convenient that would be", () => {
    /* A command key that also reads is a command key carried everywhere a read
       key is carried, which is exactly the exposure the split exists to avoid. */
    expect(authorizeEngineReadRequest(reqWith(COMMAND_KEY) as never)).toBe(false);
  });

  it("stays separate even when the two secrets are the same LENGTH", () => {
    /* Length equality is what makes a lazy compare look like it works. */
    vi.stubEnv("ENGINE_READ_API_KEY", "a".repeat(32));
    vi.stubEnv("BILLING_COMMAND_API_KEY", "b".repeat(32));
    expect(authorizeEngineReadRequest(reqWith("b".repeat(32)) as never)).toBe(false);
    expect(authorizeEngineCommandRequest(reqWith("a".repeat(32)) as never)).toBe(false);
  });
});
