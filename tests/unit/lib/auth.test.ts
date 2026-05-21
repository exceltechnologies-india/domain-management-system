import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";

// Must mock auth-secret BEFORE importing AuthService, because auth.ts
// reads AUTH_SECRET at module evaluation time.
vi.mock("@/lib/auth-secret", () => ({
  AUTH_SECRET: "test-jwt-secret-1234567890-for-unit-tests-only",
}));

// Stub server-side dependencies so auth.ts can be imported in jsdom
vi.mock("@/lib/mongodb", () => ({ default: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth-config", () => ({ authOptions: {} }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
vi.mock("@/models/User", () => ({
  default: { findById: vi.fn().mockResolvedValue(null) },
}));

const TEST_SECRET = "test-jwt-secret-1234567890-for-unit-tests-only";

// Import AFTER mocks are registered
import { AuthService, JWTPayload } from "@/lib/auth";

const VALID_PAYLOAD: JWTPayload = {
  userId: "507f1f77bcf86cd799439011",
  email: "test@example.com",
  role: "user",
};

describe("AuthService.generateToken", () => {
  it("returns a non-empty string", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("generates a valid JWT with 3 segments", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    expect(token.split(".").length).toBe(3);
  });

  it("token payload contains userId, email, and role", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const decoded = jwt.decode(token) as any;
    expect(decoded.userId).toBe(VALID_PAYLOAD.userId);
    expect(decoded.email).toBe(VALID_PAYLOAD.email);
    expect(decoded.role).toBe(VALID_PAYLOAD.role);
  });

  it("sets 24h expiry by default (rememberMe = false)", () => {
    const before = Math.floor(Date.now() / 1000);
    const token = AuthService.generateToken(VALID_PAYLOAD, false);
    const decoded = jwt.decode(token) as any;
    const expiresIn = decoded.exp - decoded.iat;
    // 24 hours = 86400 seconds (allow ±5s for test timing)
    expect(expiresIn).toBeGreaterThanOrEqual(86395);
    expect(expiresIn).toBeLessThanOrEqual(86405);
  });

  it("sets 30-day expiry when rememberMe = true", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD, true);
    const decoded = jwt.decode(token) as any;
    const expiresIn = decoded.exp - decoded.iat;
    // 30 days = 2592000 seconds
    expect(expiresIn).toBeGreaterThanOrEqual(2591995);
    expect(expiresIn).toBeLessThanOrEqual(2592005);
  });

  it("adds a unique jti claim to each token", () => {
    const t1 = AuthService.generateToken(VALID_PAYLOAD);
    const t2 = AuthService.generateToken(VALID_PAYLOAD);
    const d1 = jwt.decode(t1) as any;
    const d2 = jwt.decode(t2) as any;
    expect(d1.jti).not.toBe(d2.jti);
  });

  it("sets issuer to 'excel-technologies'", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const decoded = jwt.decode(token) as any;
    expect(decoded.iss).toBe("excel-technologies");
  });

  it("sets audience to 'domain-management-system'", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const decoded = jwt.decode(token) as any;
    expect(decoded.aud).toBe("domain-management-system");
  });
});

describe("AuthService.verifyToken", () => {
  it("returns the payload for a valid token", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const result = AuthService.verifyToken(token);
    expect(result).not.toBeNull();
    expect(result?.userId).toBe(VALID_PAYLOAD.userId);
    expect(result?.email).toBe(VALID_PAYLOAD.email);
    expect(result?.role).toBe(VALID_PAYLOAD.role);
  });

  it("returns null for a tampered token (wrong secret)", () => {
    const tampered = jwt.sign(VALID_PAYLOAD, "wrong-secret", {
      issuer: "excel-technologies",
      audience: "domain-management-system",
    });
    expect(AuthService.verifyToken(tampered)).toBeNull();
  });

  it("returns null for an expired token", () => {
    const expired = jwt.sign(VALID_PAYLOAD, TEST_SECRET, {
      expiresIn: -1, // expired 1 second ago
      issuer: "excel-technologies",
      audience: "domain-management-system",
    });
    expect(AuthService.verifyToken(expired)).toBeNull();
  });

  it("returns null for a completely invalid string", () => {
    expect(AuthService.verifyToken("not.a.token")).toBeNull();
    expect(AuthService.verifyToken("random-garbage")).toBeNull();
    expect(AuthService.verifyToken("")).toBeNull();
  });

  it("returns null if the token is missing userId", () => {
    // Token with missing required claim
    const incomplete = jwt.sign(
      { email: "test@example.com", role: "user" },
      TEST_SECRET,
      { issuer: "excel-technologies", audience: "domain-management-system" }
    );
    expect(AuthService.verifyToken(incomplete)).toBeNull();
  });

  it("returns null if the token is missing email", () => {
    const incomplete = jwt.sign(
      { userId: "507f1f77bcf86cd799439011", role: "user" },
      TEST_SECRET,
      { issuer: "excel-technologies", audience: "domain-management-system" }
    );
    expect(AuthService.verifyToken(incomplete)).toBeNull();
  });

  it("returns null if the token is missing role", () => {
    const incomplete = jwt.sign(
      { userId: "507f1f77bcf86cd799439011", email: "test@example.com" },
      TEST_SECRET,
      { issuer: "excel-technologies", audience: "domain-management-system" }
    );
    expect(AuthService.verifyToken(incomplete)).toBeNull();
  });

  it("returns null for a token with wrong issuer", () => {
    const wrongIssuer = jwt.sign(VALID_PAYLOAD, TEST_SECRET, {
      issuer: "other-system",
      audience: "domain-management-system",
    });
    expect(AuthService.verifyToken(wrongIssuer)).toBeNull();
  });

  it("returns null for a token with wrong audience", () => {
    const wrongAud = jwt.sign(VALID_PAYLOAD, TEST_SECRET, {
      issuer: "excel-technologies",
      audience: "other-audience",
    });
    expect(AuthService.verifyToken(wrongAud)).toBeNull();
  });

  it("a generated-then-verified token round-trips correctly", () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const verified = AuthService.verifyToken(token);
    expect(verified?.userId).toBe(VALID_PAYLOAD.userId);
    expect(verified?.email).toBe(VALID_PAYLOAD.email);
    expect(verified?.role).toBe(VALID_PAYLOAD.role);
  });
});

// ─── Unsigned-token rejection (regression guard for the deleted base64 fallback) ─
// Earlier code accepted a Bearer payload of `base64(JSON.stringify({userId, email,
// role}))` if jwt.verify failed and the token had no dots. That was an auth
// bypass — any attacker who could enumerate or guess an admin _id could
// authenticate as that admin without ever knowing JWT_SECRET. These cases
// pin the verifier to JWT-only.

function makeBase64Token(payload: object): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

describe("AuthService.verifyToken — rejects unsigned base64 tokens", () => {
  it("rejects a base64-encoded JSON payload that mimics a valid claim set", () => {
    // This is the exact shape a forged admin token would take.
    const payload = {
      userId: "507f1f77bcf86cd799439011",
      email: "admin@example.com",
      role: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    };
    const token = makeBase64Token(payload);
    expect(token.includes(".")).toBe(false);
    expect(AuthService.verifyToken(token)).toBeNull();
  });

  it("rejects a dot-less alphanumeric string that isn't a JWT", () => {
    expect(AuthService.verifyToken("dGVzdHRva2Vu")).toBeNull();
  });
});

// ─── getUserFromRequest / isAdmin / isAuthenticated ──────────────────────────

function makeRequest(authHeader?: string) {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? (authHeader ?? null) : null,
    },
  } as any;
}

const MOCK_USER_BASE = {
  _id: "507f1f77bcf86cd799439011",
  email: "test@example.com",
  role: "user",
  isActive: true,
  sessionInvalidatedAt: null,
};

describe("AuthService.getUserFromRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns user when a valid Bearer JWT is present", async () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const User = (await import("@/models/User")).default as any;
    User.findById.mockResolvedValue({ ...MOCK_USER_BASE, isActive: true });

    const result = await AuthService.getUserFromRequest(
      makeRequest(`Bearer ${token}`)
    );
    expect(result).not.toBeNull();
    expect(result!.email).toBe("test@example.com");
  });

  it("returns null when the Bearer token is invalid", async () => {
    const result = await AuthService.getUserFromRequest(
      makeRequest("Bearer this.is.notvalid")
    );
    expect(result).toBeNull();
  });

  it("returns null when token is valid but user is not found in DB", async () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const User = (await import("@/models/User")).default as any;
    User.findById.mockResolvedValue(null);

    const result = await AuthService.getUserFromRequest(
      makeRequest(`Bearer ${token}`)
    );
    expect(result).toBeNull();
  });

  it("returns null when user account is inactive", async () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const User = (await import("@/models/User")).default as any;
    User.findById.mockResolvedValue({ ...MOCK_USER_BASE, isActive: false });

    const result = await AuthService.getUserFromRequest(
      makeRequest(`Bearer ${token}`)
    );
    expect(result).toBeNull();
  });

  it("returns null when session was invalidated after token was issued", async () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const User = (await import("@/models/User")).default as any;
    // sessionInvalidatedAt is in the future relative to token issuance
    User.findById.mockResolvedValue({
      ...MOCK_USER_BASE,
      isActive: true,
      sessionInvalidatedAt: new Date(Date.now() + 10_000),
    });

    const result = await AuthService.getUserFromRequest(
      makeRequest(`Bearer ${token}`)
    );
    expect(result).toBeNull();
  });

  it("falls back to NextAuth session when no Bearer token is provided", async () => {
    const { getServerSession } = await import("next-auth/next");
    const User = (await import("@/models/User")).default as any;
    vi.mocked(getServerSession).mockResolvedValue({
      user: { id: "507f1f77bcf86cd799439011", email: "test@example.com" },
    } as any);
    User.findById.mockResolvedValue({ ...MOCK_USER_BASE, isActive: true });

    const result = await AuthService.getUserFromRequest(makeRequest());
    expect(result).not.toBeNull();
  });

  it("returns null when no token and no session", async () => {
    const { getServerSession } = await import("next-auth/next");
    vi.mocked(getServerSession).mockResolvedValue(null);

    const result = await AuthService.getUserFromRequest(makeRequest());
    expect(result).toBeNull();
  });
});

describe("AuthService.isAdmin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true for an admin user", async () => {
    const token = AuthService.generateToken({ ...VALID_PAYLOAD, role: "admin" });
    const User = (await import("@/models/User")).default as any;
    User.findById.mockResolvedValue({ ...MOCK_USER_BASE, role: "admin", isActive: true });

    const result = await AuthService.isAdmin(makeRequest(`Bearer ${token}`));
    expect(result).toBe(true);
  });

  it("returns false for a regular user", async () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const User = (await import("@/models/User")).default as any;
    User.findById.mockResolvedValue({ ...MOCK_USER_BASE, role: "user", isActive: true });

    const result = await AuthService.isAdmin(makeRequest(`Bearer ${token}`));
    expect(result).toBe(false);
  });

  it("returns false when no auth is present", async () => {
    const { getServerSession } = await import("next-auth/next");
    vi.mocked(getServerSession).mockResolvedValue(null);

    expect(await AuthService.isAdmin(makeRequest())).toBe(false);
  });
});

describe("AuthService.isAuthenticated", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when a valid user is found", async () => {
    const token = AuthService.generateToken(VALID_PAYLOAD);
    const User = (await import("@/models/User")).default as any;
    User.findById.mockResolvedValue({ ...MOCK_USER_BASE, isActive: true });

    expect(await AuthService.isAuthenticated(makeRequest(`Bearer ${token}`))).toBe(true);
  });

  it("returns false when no user is found", async () => {
    const { getServerSession } = await import("next-auth/next");
    vi.mocked(getServerSession).mockResolvedValue(null);

    expect(await AuthService.isAuthenticated(makeRequest())).toBe(false);
  });
});
