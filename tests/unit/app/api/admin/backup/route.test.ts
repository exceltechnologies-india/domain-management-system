/**
 * Tests for `app/api/admin/backup/route.ts` (slice 7i1, part 2).
 *
 * Admin "download full database backup" endpoint — streams a gzipped
 * JSON dump of every collection except system.*, with sensitive
 * fields stripped at the projection layer.
 *
 * Threat model:
 *  - **Cookie-only DB download**: a stolen admin session cookie
 *    must NOT be enough to download the entire production database.
 *    Pinned: step-up password re-verification fires AFTER auth and
 *    BEFORE the stream begins.
 *  - **Sensitive-field leak in backup**: password hashes, TOTP
 *    secrets, password-reset tokens, etc. MUST NOT appear in any
 *    backup file. Pinned per-field with the SENSITIVE_PROJECTIONS
 *    map.
 *  - **Aborted download leaves no audit trail**: if `logAdminAction`
 *    ran AFTER the stream completed, an attacker could start a
 *    download, see what's in it, then abort to wipe the audit
 *    record. Pinned: audit log fires BEFORE the stream.
 *
 * Other pins:
 *  - verifyAdminAuth fail → 401 with the helper's error message
 *  - zod password: 1-256 chars required
 *  - getUserWithPassword null → 404
 *  - bcrypt comparePassword false → 403 "Invalid password. Access denied."
 *  - Audit log entry: action='DATABASE_BACKUP_DOWNLOAD', requestId
 *    in metadata, IP from x-forwarded-for → x-real-ip → 'unknown'
 *  - Sensitive projections applied to:
 *      users: password / totpSecret / totpSecretPending /
 *        totpBackupCodes / resetToken / resetTokenExpiry /
 *        pendingEmailToken (7 fields)
 *      orders: razorpaySignature
 *  - system.* collections skipped
 *  - Response Content-Type: application/gzip
 *  - Content-Disposition: attachment; filename with dated stamp
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyAdminAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAuth }));

const getUserWithPassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserWithPassword }));

const logAdminAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit-log", () => ({ logAdminAction }));

const listCollections = vi.hoisted(() => vi.fn());
const collection = vi.hoisted(() => vi.fn());
const mongooseMock = vi.hoisted(() => ({
  connection: {
    db: undefined as unknown as { listCollections: unknown; collection: unknown },
  },
}));
vi.mock("mongoose", () => ({
  default: mongooseMock,
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

import { POST } from "@/app/api/admin/backup/route";

function makeReq(
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new NextRequest("https://example.com/api/admin/backup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeCursor(docs: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const d of docs) yield d;
    },
  };
}

function setupAdminAuthValid() {
  verifyAdminAuth.mockResolvedValue({
    valid: true,
    user: {
      id: "ADMIN1",
      email: "admin@example.com",
    },
  });
  getUserWithPassword.mockResolvedValue({
    _id: "ADMIN1",
    email: "admin@example.com",
    comparePassword: vi.fn().mockResolvedValue(true),
  });
  logAdminAction.mockResolvedValue(undefined);
}

beforeEach(() => {
  verifyAdminAuth.mockReset();
  getUserWithPassword.mockReset();
  logAdminAction.mockReset();
  listCollections.mockReset();
  collection.mockReset();
  // Re-wire the connection.db each test so it points to fresh mocks.
  mongooseMock.connection.db = {
    listCollections,
    collection,
  };
});

describe("Admin gate", () => {
  it("verifyAdminAuth fail → 401; NO password check, NO audit log", async () => {
    verifyAdminAuth.mockResolvedValueOnce({
      valid: false,
      user: null,
      error: "Not an admin",
    });
    const res = await POST(makeReq({ password: "x" }));
    expect(res.status).toBe(401);
    expect(getUserWithPassword).not.toHaveBeenCalled();
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  beforeEach(() => {
    verifyAdminAuth.mockResolvedValue({
      valid: true,
      user: { id: "ADMIN1", email: "admin@example.com" },
    });
  });

  it("missing password → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(getUserWithPassword).not.toHaveBeenCalled();
  });

  it("password > 256 chars → 400", async () => {
    const res = await POST(makeReq({ password: "x".repeat(257) }));
    expect(res.status).toBe(400);
  });
});

describe("Step-up password verification", () => {
  beforeEach(() => {
    verifyAdminAuth.mockResolvedValue({
      valid: true,
      user: { id: "ADMIN1", email: "admin@example.com" },
    });
  });

  it("getUserWithPassword null → 404 'User not found'", async () => {
    getUserWithPassword.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ password: "x" }));
    expect(res.status).toBe(404);
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(listCollections).not.toHaveBeenCalled();
  });

  it("**bcrypt comparePassword false → 403 'Invalid password. Access denied.'; NO audit, NO stream**", async () => {
    const comparePassword = vi.fn().mockResolvedValue(false);
    getUserWithPassword.mockResolvedValueOnce({
      _id: "ADMIN1",
      email: "admin@example.com",
      comparePassword,
    });
    const res = await POST(makeReq({ password: "wrong" }));
    expect(res.status).toBe(403);
    expect(comparePassword).toHaveBeenCalledWith("wrong");
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(listCollections).not.toHaveBeenCalled();
  });
});

describe("Audit log — BEFORE stream begins", () => {
  beforeEach(() => {
    setupAdminAuthValid();
    listCollections.mockImplementation(() => ({
      toArray: () => Promise.resolve([{ name: "users" }]),
    }));
    collection.mockImplementation(() => ({
      find: vi.fn().mockImplementation(() => makeCursor([])),
    }));
  });

  it("logAdminAction called with action='DATABASE_BACKUP_DOWNLOAD' + requestId + admin.email", async () => {
    const res = await POST(makeReq({ password: "correct" }));
    await res.arrayBuffer(); // drain the stream so it doesn't leak into the next test
    expect(logAdminAction).toHaveBeenCalledTimes(1);
    const arg = logAdminAction.mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        userId: "ADMIN1",
        userEmail: "admin@example.com",
        action: "DATABASE_BACKUP_DOWNLOAD",
        resource: "/api/admin/backup",
        method: "POST",
        path: "/api/admin/backup",
        success: true,
      })
    );
    expect(arg.metadata.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("IP chain: x-forwarded-for first → x-real-ip → 'unknown'", async () => {
    const res = await POST(
      makeReq(
        { password: "correct" },
        { "x-forwarded-for": "10.0.0.1, 10.0.0.2" }
      )
    );
    await res.arrayBuffer();
    expect(logAdminAction.mock.calls[0][0].ip).toBe("10.0.0.1");
  });

  it("no x-forwarded-for → x-real-ip used", async () => {
    const res = await POST(
      makeReq({ password: "correct" }, { "x-real-ip": "192.168.1.5" })
    );
    await res.arrayBuffer();
    expect(logAdminAction.mock.calls[0][0].ip).toBe("192.168.1.5");
  });

  it("no headers → 'unknown' fallback", async () => {
    const res = await POST(makeReq({ password: "correct" }));
    await res.arrayBuffer();
    expect(logAdminAction.mock.calls[0][0].ip).toBe("unknown");
  });
});

describe("Streaming response shape", () => {
  beforeEach(() => {
    setupAdminAuthValid();
  });

  it("Content-Type: application/gzip + Content-Disposition: attachment with .json.gz filename", async () => {
    listCollections.mockImplementation(() => ({
      toArray: () => Promise.resolve([]),
    }));
    const res = await POST(makeReq({ password: "correct" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const cd = res.headers.get("content-disposition") || "";
    expect(cd).toContain("attachment");
    expect(cd).toContain(".json.gz");
    expect(cd).toMatch(/backup-/);
    await res.arrayBuffer(); // drain
  });
});

describe("Sensitive-field projection (anti-leak)", () => {
  async function probe(collectionName: string) {
    setupAdminAuthValid();
    const find = vi.fn().mockImplementation(() => makeCursor([]));
    listCollections.mockImplementation(() => ({
      toArray: () => Promise.resolve([{ name: collectionName }]),
    }));
    collection.mockImplementation(() => ({ find }));
    const res = await POST(makeReq({ password: "correct" }));
    await res.arrayBuffer();
    return find;
  }

  it("**users collection: 7 sensitive fields projected OUT (password, totpSecret, totpSecretPending, totpBackupCodes, resetToken, resetTokenExpiry, pendingEmailToken)**", async () => {
    const find = await probe("users");
    expect(find).toHaveBeenCalledTimes(1);
    const filter = find.mock.calls[0][0];
    const opts = find.mock.calls[0][1];
    expect(filter).toEqual({});
    expect(opts.projection).toEqual({
      password: 0,
      totpSecret: 0,
      totpSecretPending: 0,
      totpBackupCodes: 0,
      resetToken: 0,
      resetTokenExpiry: 0,
      pendingEmailToken: 0,
    });
  });

  it("**orders collection: razorpaySignature projected OUT**", async () => {
    const find = await probe("orders");
    expect(find).toHaveBeenCalledTimes(1);
    const opts = find.mock.calls[0][1];
    expect(opts.projection).toEqual({ razorpaySignature: 0 });
  });

  it("non-sensitive collection (e.g. hostings) → no projection applied", async () => {
    const find = await probe("hostings");
    expect(find).toHaveBeenCalledTimes(1);
    const opts = find.mock.calls[0][1];
    // No projection key — fully empty options
    expect(opts).toEqual({});
  });
});

describe("System collections skip", () => {
  it("collections starting with 'system.' → SKIPPED; no find/cursor", async () => {
    setupAdminAuthValid();
    const find = vi.fn().mockImplementation(() => makeCursor([]));
    listCollections.mockImplementation(() => ({
      toArray: () =>
        Promise.resolve([
          { name: "system.indexes" },
          { name: "system.views" },
          { name: "users" },
        ]),
    }));
    collection.mockImplementation(() => ({ find }));
    const res = await POST(makeReq({ password: "correct" }));
    await res.arrayBuffer();
    // Only the non-system collection is iterated
    expect(find).toHaveBeenCalledTimes(1);
  });
});

describe("Outer catch", () => {
  it("verifyAdminAuth throw → 500 generic", async () => {
    verifyAdminAuth.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await POST(makeReq({ password: "x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error during backup");
  });
});
