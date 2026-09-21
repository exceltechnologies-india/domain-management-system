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
 *    LIVE_COMMANDS_ENABLED configurable, that is the regression.
 *  - **503, not 403.** The caller's credentials are fine and it is allowed to
 *    ask for live; this engine is not ready to serve it. A 403 reads as "your
 *    key is wrong" and sends someone to rotate a perfectly good credential.
 */
import { describe, it, expect } from "vitest";
import {
  checkMode,
  mayContactProvider,
  LIVE_COMMANDS_ENABLED,
  ENGINE_MODES,
} from "@/lib/integrations/engine-mode";

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

describe("test mode is accepted", () => {
  it("returns the mode", () => {
    expect(checkMode("test")).toEqual({ ok: true, mode: "test" });
  });
});

describe("live is hard-disabled in this build", () => {
  it("LIVE_COMMANDS_ENABLED is false", () => {
    // The whole of Phase 4 rests on this. If it is true, the command path can
    // spend money and every other test here is describing something else.
    expect(LIVE_COMMANDS_ENABLED).toBe(false);
  });

  it("checkMode('live') → 503, not 403", () => {
    const r = checkMode("live");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.status).not.toBe(403);
    }
  });

  it("the refusal tells the caller what to do instead", () => {
    const r = checkMode("live");
    if (!r.ok) {
      expect(r.error).toMatch(/mode:"test"|mode:\\"test\\"|test/i);
      // And that turning it on is not a setting — so nobody hunts for a flag.
      expect(r.error).toMatch(/code change|deploy/i);
    }
  });
});

describe("mayContactProvider — nothing may, at this phase", () => {
  it("test mode never contacts a provider", () => {
    expect(mayContactProvider("test")).toBe(false);
  });

  it("live mode does not either, while live is disabled", () => {
    expect(mayContactProvider("live")).toBe(false);
  });

  it("no mode can reach a provider in this build", () => {
    // Stated as a single claim, because "can anything here spend money" is the
    // question this phase exists to answer NO to.
    expect(ENGINE_MODES.some(mayContactProvider)).toBe(false);
  });
});
