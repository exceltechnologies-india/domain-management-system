import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
} from "@/lib/unsubscribe-token";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-for-unsubscribe");
  vi.stubEnv("APP_URL", "https://app.test.example");
});

describe("unsubscribe-token", () => {
  it("round-trips: verify(make(email)) === lowercased email", () => {
    const t = makeUnsubscribeToken("User@Example.com");
    expect(verifyUnsubscribeToken(t)).toBe("user@example.com");
  });

  it("rejects a tampered payload (different email, same sig)", () => {
    const t = makeUnsubscribeToken("a@x.com");
    const sig = t.split(".")[1];
    const forged = `${Buffer.from("b@x.com").toString("base64url")}.${sig}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const t = makeUnsubscribeToken("a@x.com");
    const [payload] = t.split(".");
    expect(verifyUnsubscribeToken(`${payload}.deadbeef`)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("nodot")).toBeNull();
    expect(verifyUnsubscribeToken(".")).toBeNull();
  });

  it("a token signed under a different secret does not verify", () => {
    const t = makeUnsubscribeToken("a@x.com");
    vi.stubEnv("NEXTAUTH_SECRET", "a-completely-different-secret");
    expect(verifyUnsubscribeToken(t)).toBeNull();
  });

  it("unsubscribeUrl embeds a verifiable token pointing at the endpoint", () => {
    const url = unsubscribeUrl("a@x.com");
    expect(url).toContain("https://app.test.example/api/notifications/unsubscribe?token=");
    const token = decodeURIComponent(url.split("token=")[1]);
    expect(verifyUnsubscribeToken(token)).toBe("a@x.com");
  });
});
