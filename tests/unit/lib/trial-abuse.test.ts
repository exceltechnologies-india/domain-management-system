/**
 * Tests for `@/lib/trial-abuse` (rescan-4 slice 7fj). Anti-abuse helpers
 * for the hosting free-trial flow. Pins:
 *  - **getClientIp precedence**: x-forwarded-for (first comma-split,
 *    trimmed) > x-real-ip > 'unknown'
 *  - **hashIp**: HMAC-SHA256 with AUTH_SECRET fallback → NEXTAUTH_SECRET
 *    → literal 'trial-abuse-fallback'; empty/'unknown' IP → ''
 *    (no raw IP ever persisted — DB-leak resilience)
 *  - **evaluateTrialAbuse pipeline** in order (cheapest first):
 *    1. Disposable email → DISPOSABLE_EMAIL
 *    2. reCAPTCHA (when a token is supplied) → RECAPTCHA
 *    3. Device fingerprint throttle: 30-day window → DEVICE_THROTTLE
 *    (IP throttle REMOVED 2026-07-15 — shared-network/CGNAT false positives;
 *     phone SMS OTP gate REMOVED 2026-07-15 — feature deleted for now.)
 *  - All-clear → {allowed:true}
 *  - **recordTrialClaim E11000 (duplicate-key race) is SWALLOWED**
 *    (the prior insert already records the claim; this attempt is a
 *    coordinated double-claim — log + return, don't throw because user
 *    paid the ₹1 trial fee already); non-E11000 → also swallowed (logged)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isDisposableEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/disposable-emails", () => ({ isDisposableEmail }));

const trialClaimExists = vi.hoisted(() => vi.fn());
const trialClaimCreate = vi.hoisted(() => vi.fn());
vi.mock("@/models/TrialClaim", () => ({
  default: { exists: trialClaimExists, create: trialClaimCreate },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getClientIp,
  hashIp,
  evaluateTrialAbuse,
  recordTrialClaim,
} from "@/lib/trial-abuse";

function mockReq(headers: Record<string, string> = {}): never {
  return { headers: new Headers(headers) } as never;
}

beforeEach(() => {
  isDisposableEmail.mockReset();
  isDisposableEmail.mockReturnValue(false);
  trialClaimExists.mockReset();
  trialClaimExists.mockResolvedValue(null);
  trialClaimCreate.mockReset();
  vi.stubEnv("AUTH_SECRET", "test-auth-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getClientIp — proxy-header precedence", () => {
  it("x-forwarded-for wins (first comma-split + trimmed)", () => {
    expect(
      getClientIp(
        mockReq({
          "x-forwarded-for": "  1.1.1.1  , 2.2.2.2",
          "x-real-ip": "3.3.3.3",
        })
      )
    ).toBe("1.1.1.1");
  });

  it("no XFF → x-real-ip", () => {
    expect(getClientIp(mockReq({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
  });

  it("nothing set → 'unknown' literal", () => {
    expect(getClientIp(mockReq({}))).toBe("unknown");
  });
});

describe("hashIp — HMAC-SHA256 with secret fallback", () => {
  it("empty IP → empty string (no raw IP ever persisted)", () => {
    expect(hashIp("")).toBe("");
  });

  it("'unknown' IP → empty string", () => {
    expect(hashIp("unknown")).toBe("");
  });

  it("real IP → 64-char hex (SHA256 length)", () => {
    expect(hashIp("1.2.3.4")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("same IP → same hash (deterministic)", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
  });

  it("different secret → different hash for same IP", () => {
    const h1 = hashIp("1.2.3.4");
    vi.stubEnv("AUTH_SECRET", "rotated-secret");
    const h2 = hashIp("1.2.3.4");
    expect(h1).not.toBe(h2);
  });
});

describe("evaluateTrialAbuse — 4-step pipeline (cheapest first)", () => {
  it("step 1: disposable email → DISPOSABLE_EMAIL (instant, no other checks run)", async () => {
    isDisposableEmail.mockReturnValueOnce(true);
    const result = await evaluateTrialAbuse(
      { email: "trash@10minutemail.com", ipHash: "abc" }
    );
    expect(result).toEqual({
      allowed: false,
      code: "DISPOSABLE_EMAIL",
      reason: expect.stringMatching(/temporary or disposable/i),
    });
    // No DB call needed.
    expect(trialClaimExists).not.toHaveBeenCalled();
  });

  it("IP throttle REMOVED (2026-07-15) — a prior claim from the same IP no longer blocks; IP is not queried", async () => {
    const result = await evaluateTrialAbuse({ ipHash: "abc123" });
    expect(result.allowed).toBe(true);
    // No throttle query fires when only an ipHash is supplied — IP is no
    // longer a gating signal (shared-network/CGNAT false positives).
    expect(trialClaimExists).not.toHaveBeenCalled();
  });

  it("device fingerprint hit → DEVICE_THROTTLE", async () => {
    trialClaimExists.mockResolvedValueOnce({ _id: "X" }); // device check hits
    const result = await evaluateTrialAbuse({
      ipHash: "abc",
      deviceFingerprint: "fp_xyz",
    });
    expect(result.code).toBe("DEVICE_THROTTLE");
  });

  it("all-clear: returns {allowed:true} only", async () => {
    const result = await evaluateTrialAbuse({
      email: "u@x.test",
      ipHash: "abc",
      deviceFingerprint: "fp",
    });
    expect(result).toEqual({ allowed: true });
  });
});

describe("recordTrialClaim — E11000 race tolerance", () => {
  it("happy path: create called with normalised lowercase email + optional fields", async () => {
    trialClaimCreate.mockResolvedValueOnce({});
    await recordTrialClaim({
      userId: "U1",
      userEmail: "Alice@X.TEST",
      ipHash: "abc",
      deviceFingerprint: "fp",
      planId: "starter",
    });
    expect(trialClaimCreate).toHaveBeenCalledWith({
      userId: "U1",
      userEmail: "alice@x.test", // lowercased
      ipHash: "abc",
      deviceFingerprint: "fp",
      planId: "starter",
    });
  });

  it("E11000 duplicate-key race → swallowed (prior insert already records the claim)", async () => {
    const dup: { code: number; message: string } & Error = Object.assign(
      new Error("dup"),
      { code: 11000 }
    );
    trialClaimCreate.mockRejectedValueOnce(dup);
    await expect(
      recordTrialClaim({ userId: "U1", userEmail: "u@x.test", ipHash: "abc" })
    ).resolves.toBeUndefined();
  });

  it("non-E11000 error → also swallowed (best-effort persistence; logged)", async () => {
    trialClaimCreate.mockRejectedValueOnce(new Error("DB connection lost"));
    await expect(
      recordTrialClaim({ userId: "U1", userEmail: "u@x.test" })
    ).resolves.toBeUndefined();
  });

  it("empty ipHash → undefined (don't persist empty string)", async () => {
    trialClaimCreate.mockResolvedValueOnce({});
    await recordTrialClaim({
      userId: "U1",
      userEmail: "u@x.test",
      ipHash: "",
    });
    const [payload] = trialClaimCreate.mock.calls[0];
    expect(payload.ipHash).toBeUndefined();
  });
});
