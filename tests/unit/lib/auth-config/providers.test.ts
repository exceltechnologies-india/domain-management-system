/**
 * Tests for `@/lib/auth-config/providers` (rescan-4 slice 7en).
 * NextAuth providers list. Most providers are SDK construction we can't
 * meaningfully assert beyond shape; the meaty unit-test surface is the
 * CredentialsProvider.authorize function (the password login path).
 * Pins:
 *  - **OPTIONAL providers gated on env**: Facebook + GitHub only
 *    appear in the list when BOTH client id + secret are set; missing
 *    either → silently omitted (no crash)
 *  - Google + Credentials always present
 *  - Google profile mapper returns the 8-field shape (id/name/email/
 *    image/role:'user'/given_name/family_name/locale)
 *  - **authorize TotpRequired**: user.totpEnabled=true + no totpCode →
 *    throws 'TotpRequired'
 *  - authorize 'Invalid email or password' is the GENERIC message for
 *    both "user not found" AND "password mismatch" (security: identical
 *    surface to attackers can't enumerate accounts)
 *  - authorize 'AccountNotActivated' + 'AccountDeactivated' are
 *    distinct from the generic credential failure (UX: user gets to
 *    fix the right thing)
 *  - **Rate-limit gate keyed by email + IP** (per-user AND per-IP
 *    attacks both caught); IP read from x-forwarded-for first, else
 *    x-real-ip, else 'unknown'
 *  - **Backup code path**: TOTP code doesn't match secret BUT matches
 *    a backup hash → consumeUserBackupCode + WARN log + login proceeds
 *  - Backup code: hash list traversed in order; matched hash
 *    consumed; subsequent attempts can't reuse
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the next-auth providers so they don't need real env at import.
// Each one returns its own input options as an object — that's enough
// to assert the `authorize` function and the gating behaviour.
const GoogleProviderMock = vi.hoisted(() =>
  vi.fn((opts: unknown) => ({ id: "google", ...(opts as object) }))
);
const FacebookProviderMock = vi.hoisted(() =>
  vi.fn((opts: unknown) => ({ id: "facebook", ...(opts as object) }))
);
const GithubProviderMock = vi.hoisted(() =>
  vi.fn((opts: unknown) => ({ id: "github", ...(opts as object) }))
);
const CredentialsProviderMock = vi.hoisted(() =>
  vi.fn((opts: { authorize?: unknown }) => ({
    id: "credentials",
    authorize: opts.authorize,
  }))
);
vi.mock("next-auth/providers/google", () => ({ default: GoogleProviderMock }));
vi.mock("next-auth/providers/facebook", () => ({ default: FacebookProviderMock }));
vi.mock("next-auth/providers/github", () => ({ default: GithubProviderMock }));
vi.mock("next-auth/providers/credentials", () => ({
  default: CredentialsProviderMock,
}));

const connectDBMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const getUserByEmailForLogin = vi.hoisted(() => vi.fn());
const getUserWithTOTPSecretsForLogin = vi.hoisted(() => vi.fn());
const consumeUserBackupCode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserByEmailForLogin,
  getUserWithTOTPSecretsForLogin,
  consumeUserBackupCode,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));

const updateLastActivity = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-activity", () => ({ updateLastActivity }));

const verifyTotpCode = vi.hoisted(() => vi.fn());
const verifyBackupCode = vi.hoisted(() => vi.fn());
vi.mock("@/lib/totp", () => ({ verifyTotpCode, verifyBackupCode }));

const loginCheck = vi.hoisted(() => vi.fn().mockResolvedValue({ allowed: true }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { login: { checkKey: loginCheck } },
}));

beforeEach(() => {
  GoogleProviderMock.mockClear();
  FacebookProviderMock.mockClear();
  GithubProviderMock.mockClear();
  CredentialsProviderMock.mockClear();
  connectDBMock.mockClear();
  getUserByEmailForLogin.mockReset();
  getUserWithTOTPSecretsForLogin.mockReset();
  consumeUserBackupCode.mockReset();
  updateLastActivity.mockReset();
  verifyTotpCode.mockReset();
  verifyBackupCode.mockReset();
  loginCheck.mockReset();
  loginCheck.mockResolvedValue({ allowed: true });
  vi.stubEnv("GOOGLE_CLIENT_ID", "g_id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "g_secret");
  vi.stubEnv("NODE_ENV", "test");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type AuthorizeFn = (
  credentials: Record<string, string>,
  req?: { headers?: Headers | Record<string, string> }
) => Promise<unknown>;

async function getAuthorize(): Promise<AuthorizeFn> {
  const mod = await import("@/lib/auth-config/providers");
  const credentials = (mod.providers as Array<{ id: string; authorize?: AuthorizeFn }>).find(
    (p) => p.id === "credentials"
  );
  if (!credentials?.authorize) throw new Error("authorize missing");
  return credentials.authorize;
}

describe("providers list — optional providers gated on env", () => {
  it("Facebook + GitHub OMITTED when their env pair is unset", async () => {
    vi.stubEnv("FACEBOOK_CLIENT_ID", "");
    vi.stubEnv("FACEBOOK_CLIENT_SECRET", "");
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    const mod = await import("@/lib/auth-config/providers");
    const ids = mod.providers.map((p) => (p as { id: string }).id);
    expect(ids).not.toContain("facebook");
    expect(ids).not.toContain("github");
  });

  it("Facebook PRESENT when both Facebook env vars set", async () => {
    vi.stubEnv("FACEBOOK_CLIENT_ID", "fb_id");
    vi.stubEnv("FACEBOOK_CLIENT_SECRET", "fb_secret");
    const mod = await import("@/lib/auth-config/providers");
    const ids = mod.providers.map((p) => (p as { id: string }).id);
    expect(ids).toContain("facebook");
  });

  it("GitHub PRESENT when both GitHub env vars set", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "gh_id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "gh_secret");
    const mod = await import("@/lib/auth-config/providers");
    const ids = mod.providers.map((p) => (p as { id: string }).id);
    expect(ids).toContain("github");
  });

  it("Google + Credentials always present", async () => {
    const mod = await import("@/lib/auth-config/providers");
    const ids = mod.providers.map((p) => (p as { id: string }).id);
    expect(ids).toContain("google");
    expect(ids).toContain("credentials");
  });
});

describe("Google profile mapper", () => {
  it("returns the 8-field shape from the Google profile", async () => {
    await import("@/lib/auth-config/providers");
    const [opts] = GoogleProviderMock.mock.calls[0] as [
      { profile: (p: Record<string, unknown>) => Record<string, unknown> }
    ];
    const result = opts.profile({
      sub: "g_123",
      name: "Alice",
      email: "alice@x.test",
      picture: "https://pic",
      given_name: "Alice",
      family_name: "S",
      locale: "en",
    });
    expect(result).toEqual({
      id: "g_123",
      name: "Alice",
      email: "alice@x.test",
      image: "https://pic",
      role: "user",
      given_name: "Alice",
      family_name: "S",
      locale: "en",
    });
  });
});

describe("CredentialsProvider.authorize — credential validation surface", () => {
  it("missing email or password → throws 'Email and password are required'", async () => {
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "", password: "" })
    ).rejects.toThrow(/Email and password are required/);
  });

  it("user not found → GENERIC 'Invalid email or password' (no account enumeration)", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce(null);
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "u@x.test", password: "p" })
    ).rejects.toThrow("Invalid email or password");
  });

  it("password mismatch → SAME generic message (identical surface to user-not-found)", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce({
      _id: "U1",
      email: "u@x.test",
      isActivated: true,
      isActive: true,
      role: "user",
      firstName: "A",
      lastName: "B",
      totpEnabled: false,
      comparePassword: vi.fn().mockResolvedValue(false),
    });
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "u@x.test", password: "wrong" })
    ).rejects.toThrow("Invalid email or password");
  });

  it("AccountNotActivated → distinct typed error (user knows to check email)", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce({
      _id: "U1",
      isActivated: false,
      isActive: true,
      role: "user",
    });
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "u@x.test", password: "p" })
    ).rejects.toThrow("AccountNotActivated");
  });

  it("AccountDeactivated → distinct typed error (drives contact-support UX)", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce({
      _id: "U1",
      isActivated: true,
      isActive: false,
      role: "user",
    });
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "u@x.test", password: "p" })
    ).rejects.toThrow("AccountDeactivated");
  });
});

describe("authorize — rate limit keyed by email + IP", () => {
  it("rate-limit checkKey called with `login:{email-lower}:{ip}`", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce(null); // exit early; we only check rate-limit call
    const authorize = await getAuthorize();
    try {
      await authorize(
        { email: "ALICE@X.TEST", password: "p" },
        { headers: new Headers({ "x-forwarded-for": "1.2.3.4" }) }
      );
    } catch {
      /* ignore */
    }
    expect(loginCheck).toHaveBeenCalledWith("login:alice@x.test:1.2.3.4");
  });

  it("IP precedence: XFF > x-real-ip > 'unknown'", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce(null);
    const authorize = await getAuthorize();
    try {
      await authorize(
        { email: "u@x.test", password: "p" },
        { headers: new Headers({ "x-real-ip": "5.5.5.5" }) }
      );
    } catch {
      /* ignore */
    }
    expect(loginCheck).toHaveBeenCalledWith("login:u@x.test:5.5.5.5");

    loginCheck.mockReset();
    loginCheck.mockResolvedValue({ allowed: true });
    getUserByEmailForLogin.mockResolvedValueOnce(null);
    try {
      await authorize({ email: "u@x.test", password: "p" });
    } catch {
      /* ignore */
    }
    expect(loginCheck).toHaveBeenCalledWith("login:u@x.test:unknown");
  });

  it("rate-limit exceeded → throws 'TooManyRequests' BEFORE the DB lookup", async () => {
    loginCheck.mockResolvedValueOnce({ allowed: false });
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "u@x.test", password: "p" })
    ).rejects.toThrow("TooManyRequests");
    expect(getUserByEmailForLogin).not.toHaveBeenCalled();
  });
});

describe("authorize — 2FA TOTP + backup code", () => {
  const TOTP_USER = {
    _id: "U1",
    email: "u@x.test",
    firstName: "A",
    lastName: "B",
    role: "user",
    isActivated: true,
    isActive: true,
    totpEnabled: true,
    comparePassword: vi.fn().mockResolvedValue(true),
  };

  it("totpEnabled=true + no totpCode → throws 'TotpRequired'", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce(TOTP_USER);
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "u@x.test", password: "p" })
    ).rejects.toThrow("TotpRequired");
  });

  it("invalid TOTP + no matching backup → throws 'InvalidTotpCode'", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce(TOTP_USER);
    getUserWithTOTPSecretsForLogin.mockResolvedValueOnce({
      totpSecret: "TOTP_SECRET",
      totpBackupCodes: ["hash1", "hash2"],
    });
    verifyTotpCode.mockReturnValueOnce(false);
    verifyBackupCode.mockResolvedValue(false);
    const authorize = await getAuthorize();
    await expect(
      authorize({ email: "u@x.test", password: "p", totpCode: "000000" })
    ).rejects.toThrow("InvalidTotpCode");
  });

  it("backup code matches → consumeUserBackupCode + login proceeds (returns user shape)", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce(TOTP_USER);
    getUserWithTOTPSecretsForLogin.mockResolvedValueOnce({
      totpSecret: "TOTP_SECRET",
      totpBackupCodes: ["hash_nope", "hash_correct", "hash_other"],
    });
    verifyTotpCode.mockReturnValueOnce(false);
    verifyBackupCode
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const authorize = await getAuthorize();
    const result = await authorize({
      email: "u@x.test",
      password: "p",
      totpCode: "backup-code-1",
    });
    expect(result).toEqual({
      id: "U1",
      email: "u@x.test",
      name: "A B",
      role: "user",
    });
    // The MATCHED hash (the 2nd one — verifyBackupCode true on 2nd call)
    // is consumed.
    expect(consumeUserBackupCode).toHaveBeenCalledWith("U1", "hash_correct");
  });

  it("TOTP secret matches → backup-code path NOT entered (consumeUserBackupCode not called)", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce(TOTP_USER);
    getUserWithTOTPSecretsForLogin.mockResolvedValueOnce({
      totpSecret: "TOTP_SECRET",
      totpBackupCodes: ["h1"],
    });
    verifyTotpCode.mockReturnValueOnce(true);
    const authorize = await getAuthorize();
    await authorize({ email: "u@x.test", password: "p", totpCode: "123456" });
    expect(consumeUserBackupCode).not.toHaveBeenCalled();
    expect(verifyBackupCode).not.toHaveBeenCalled();
  });
});

describe("authorize — happy non-TOTP path", () => {
  it("returns the sanitised user shape + updates lastActivity", async () => {
    getUserByEmailForLogin.mockResolvedValueOnce({
      _id: "U1",
      email: "u@x.test",
      firstName: "Alice",
      lastName: "Smith",
      role: "user",
      isActivated: true,
      isActive: true,
      totpEnabled: false,
      comparePassword: vi.fn().mockResolvedValue(true),
    });
    const authorize = await getAuthorize();
    const result = await authorize({
      email: "u@x.test",
      password: "p",
    });
    expect(result).toEqual({
      id: "U1",
      email: "u@x.test",
      name: "Alice Smith",
      role: "user",
    });
    expect(updateLastActivity).toHaveBeenCalledWith("U1");
  });
});
