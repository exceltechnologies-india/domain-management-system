/**
 * Tests for `app/api/admin/users/reset-password/route.ts` (slice 7ht, part 1).
 *
 * Admin "reset a customer's password" action. Customer-service-tier
 * tooling — but with strong privilege guards so it can't be turned
 * into an admin-escalation primitive.
 *
 * Threat model:
 *  - **Cookie-only password change**: a stolen admin session cookie
 *    must NOT alone be enough to reset arbitrary customer passwords.
 *    Pinned: `requireReAuth` step-up check fires BEFORE any state
 *    mutation — fail → 403 REAUTH_REQUIRED.
 *  - **Admin-via-customer-service uplift**: a curious admin can't
 *    use this endpoint to wipe a peer admin's password (a real
 *    incident vector — customer-service tooling getting used against
 *    other admins). Pinned: targetUser.role==='admin' → 403, NO
 *    password write.
 *  - **Self-target bypass of the admin-protection-aware flow**: an
 *    admin using this endpoint on themselves would bypass the proper
 *    admin self-reset flow (which has its own audit trail). Pinned:
 *    self-target → 400.
 *
 * Other pins:
 *  - Admin gate → 403 (NOT 401 — admin _had_ to be authed to reach
 *    this point, the gate is "is admin role enough")
 *  - Re-auth check uses adminId derived from user._id ?? user.id
 *  - Zod: userId via Schemas.id, newPassword min:6 max:256, sendEmail
 *    optional default:true
 *  - bcrypt: genSalt(12) → hash; password set; old resetToken cleared
 *  - sendEmail=false → no email; emailSent:false in response
 *  - sendEmail=true (default) → notification email; swallow on fail
 *    (response still success — defensive, per the comment)
 *  - Outer catch → 500 generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const requireReAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-security", () => ({ requireReAuth }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const sendPasswordResetNotificationEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendPasswordResetNotificationEmail },
}));

const genSalt = vi.hoisted(() => vi.fn());
const hash = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({
  default: { genSalt, hash },
  genSalt,
  hash,
}));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/users/reset-password/route";

const ADMIN_ID = "507f1f77bcf86cd799439001";
const TARGET_ID = "507f1f77bcf86cd799439002";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/admin/users/reset-password",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function targetUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: TARGET_ID,
    email: "bob@example.com",
    firstName: "Bob",
    lastName: "Smith",
    role: "user",
    password: "$2a$12$OLD_HASH",
    resetToken: "OLD_RESET_TOKEN",
    resetTokenExpiry: new Date("2025-01-01"),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({
    _id: ADMIN_ID,
    email: "admin@example.com",
  });
  requireReAuth.mockReset().mockResolvedValue({ passed: true });
  getUserById.mockReset();
  sendPasswordResetNotificationEmail.mockReset().mockResolvedValue(undefined);
  genSalt.mockReset().mockResolvedValue("SALT");
  hash.mockReset().mockResolvedValue("$2a$12$NEW_HASH");
});

describe("Admin gate", () => {
  it("non-admin → 403 Admin access required; NO downstream calls", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    expect(res.status).toBe(403);
    expect(requireReAuth).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe("Step-up re-auth (cookie-only-defence)", () => {
  it("reauth.passed=false → 403 REAUTH_REQUIRED; NO target lookup, NO password mutation", async () => {
    requireReAuth.mockResolvedValueOnce({ passed: false });
    const res = await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("REAUTH_REQUIRED");
    expect(getUserById).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it("requireReAuth called with the resolved adminId (anti-impersonation)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: ADMIN_ID });
    getUserById.mockResolvedValueOnce(targetUser());
    await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    expect(requireReAuth).toHaveBeenCalledWith(expect.anything(), ADMIN_ID);
  });
});

describe("Zod schema", () => {
  it("newPassword < 6 chars → 400", async () => {
    const res = await POST(makeReq({ userId: TARGET_ID, newPassword: "short" }));
    expect(res.status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
  });

  it("newPassword > 256 chars → 400", async () => {
    const res = await POST(
      makeReq({ userId: TARGET_ID, newPassword: "x".repeat(257) })
    );
    expect(res.status).toBe(400);
  });

  it("missing userId → 400", async () => {
    const res = await POST(makeReq({ newPassword: "newpass123" }));
    expect(res.status).toBe(400);
  });
});

describe("Target-user lookup + 404", () => {
  it("getUserById null → 404; NO password mutation", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    expect(res.status).toBe(404);
    expect(hash).not.toHaveBeenCalled();
  });
});

describe("Privilege guards", () => {
  it("ADMIN-VIA-CUSTOMER-SERVICE block: target.role='admin' → 403 'Cannot reset admin'; NO write", async () => {
    const OTHER_ADMIN_ID = "507f1f77bcf86cd799439099";
    const otherAdmin = targetUser({ role: "admin", _id: OTHER_ADMIN_ID });
    getUserById.mockResolvedValueOnce(otherAdmin);
    const res = await POST(
      makeReq({ userId: OTHER_ADMIN_ID, newPassword: "newpass123" })
    );
    expect(res.status).toBe(403);
    expect(hash).not.toHaveBeenCalled();
    expect(otherAdmin.save).not.toHaveBeenCalled();
    expect(sendPasswordResetNotificationEmail).not.toHaveBeenCalled();
  });

  it("SELF-TARGET block: userId === admin's own _id → 400 'Use admin settings'; NO write", async () => {
    getUserById.mockResolvedValueOnce(targetUser({ _id: ADMIN_ID }));
    const res = await POST(
      makeReq({ userId: ADMIN_ID, newPassword: "newpass123" })
    );
    expect(res.status).toBe(400);
    expect(hash).not.toHaveBeenCalled();
  });
});

describe("Happy path — bcrypt + clear-token + save", () => {
  it("bcrypt genSalt(12) → hash(newPassword, salt); target.password updated; resetToken+expiry cleared; save called", async () => {
    const t = targetUser();
    getUserById.mockResolvedValueOnce(t);
    await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    expect(genSalt).toHaveBeenCalledWith(12);
    expect(hash).toHaveBeenCalledWith("newpass123", "SALT");
    expect(t.password).toBe("$2a$12$NEW_HASH");
    expect(t.resetToken).toBeUndefined();
    expect(t.resetTokenExpiry).toBeUndefined();
    expect(t.save).toHaveBeenCalledTimes(1);
  });
});

describe("Notification email", () => {
  it("sendEmail default (true) → email fires; response emailSent:true", async () => {
    getUserById.mockResolvedValueOnce(targetUser());
    const res = await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    const body = await res.json();
    expect(body.emailSent).toBe(true);
    expect(sendPasswordResetNotificationEmail).toHaveBeenCalledWith(
      "bob@example.com",
      "Bob Smith",
      "newpass123"
    );
  });

  it("sendEmail=false → email NOT sent; response emailSent:false", async () => {
    getUserById.mockResolvedValueOnce(targetUser());
    const res = await POST(
      makeReq({
        userId: TARGET_ID,
        newPassword: "newpass123",
        sendEmail: false,
      })
    );
    const body = await res.json();
    expect(body.emailSent).toBe(false);
    expect(sendPasswordResetNotificationEmail).not.toHaveBeenCalled();
  });

  it("email send throw → SWALLOWED; password change still 200 (password mutation already committed)", async () => {
    const t = targetUser();
    getUserById.mockResolvedValueOnce(t);
    sendPasswordResetNotificationEmail.mockRejectedValueOnce(
      new Error("SMTP down — apk_LEAK_ME")
    );
    const res = await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    expect(res.status).toBe(200);
    expect(t.save).toHaveBeenCalledTimes(1); // password change persisted
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("apk_LEAK_ME");
  });
});

describe("Outer catch", () => {
  it("save throw → 500 generic; sentinel NOT leaked", async () => {
    const t = targetUser();
    t.save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Mongo down — $2a$12$BCRYPT_LEAK"));
    getUserById.mockResolvedValueOnce(t);
    const res = await POST(
      makeReq({ userId: TARGET_ID, newPassword: "newpass123" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK");
  });
});
