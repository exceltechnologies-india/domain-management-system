/**
 * Tests for `@/lib/services/resellers` (sub-reseller Phase 1).
 * Pins: create (+ duplicate-email reject + setup email), approve (status +
 * role flip), suspend, and the list read chain. connectDB + models + email
 * are mocked (no DB / no mail).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const userFindOneMock = vi.hoisted(() => vi.fn());
const userCreateMock = vi.hoisted(() => vi.fn());
const userUpdateOneMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/User", () => ({
  default: { findOne: userFindOneMock, create: userCreateMock, updateOne: userUpdateOneMock },
}));

const resellerExistsMock = vi.hoisted(() => vi.fn());
const resellerCreateMock = vi.hoisted(() => vi.fn());
const resellerFindByIdMock = vi.hoisted(() => vi.fn());
const resellerFindMock = vi.hoisted(() => vi.fn());
const resellerFindOneMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/Reseller", () => ({
  default: {
    exists: resellerExistsMock,
    create: resellerCreateMock,
    findById: resellerFindByIdMock,
    find: resellerFindMock,
    findOne: resellerFindOneMock,
  },
}));

const sendPasswordResetEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  EmailService: { sendPasswordResetEmail: sendPasswordResetEmailMock },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createReseller,
  approveReseller,
  suspendReseller,
  listResellers,
  ResellerError,
} from "@/lib/services/resellers";

beforeEach(() => {
  vi.clearAllMocks();
  connectDBMock.mockResolvedValue(undefined);
});

describe("createReseller", () => {
  beforeEach(() => {
    userFindOneMock.mockReturnValue({ select: () => Promise.resolve(null) }); // no existing user
    userCreateMock.mockResolvedValue({ _id: "user1" });
    resellerExistsMock.mockResolvedValue(null); // slug free
    resellerCreateMock.mockImplementation((doc) => Promise.resolve({ _id: "res1", ...doc }));
  });

  it("creates a user + pending reseller and sends a setup email", async () => {
    const res = await createReseller(
      { email: "Owner@Acme.com", businessName: "Acme Web Services", markupPercent: 15 },
      "admin1"
    );
    // user created with role 'user' (flip happens on approval) + a reset token
    const userArg = userCreateMock.mock.calls[0][0];
    expect(userArg.email).toBe("owner@acme.com");
    expect(userArg.role).toBe("user");
    expect(userArg.resetToken).toBeTruthy();
    // reseller created pending, slug derived, markup carried
    const resArg = resellerCreateMock.mock.calls[0][0];
    expect(resArg.ownerUserId).toBe("user1");
    expect(resArg.status).toBe("pending");
    expect(resArg.slug).toBe("acme-web-services");
    expect(resArg.markupPercent).toBe(15);
    // setup email fired with isSetup=true
    expect(sendPasswordResetEmailMock).toHaveBeenCalledWith(
      "owner@acme.com",
      "Acme Web Services",
      expect.any(String),
      true
    );
    expect(res).toMatchObject({ _id: "res1", status: "pending" });
  });

  it("rejects a duplicate email with EMAIL_IN_USE (409), no user/reseller created", async () => {
    userFindOneMock.mockReturnValue({ select: () => Promise.resolve({ _id: "existing" }) });
    await expect(
      createReseller({ email: "dupe@acme.com", businessName: "Dupe" }, "admin1")
    ).rejects.toMatchObject({ code: "EMAIL_IN_USE", status: 409 });
    expect(userCreateMock).not.toHaveBeenCalled();
    expect(resellerCreateMock).not.toHaveBeenCalled();
  });
});

describe("approveReseller", () => {
  it("sets status approved + flips the owner's role to reseller", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    resellerFindByIdMock.mockResolvedValue({ _id: "res1", ownerUserId: "user1", status: "pending", save });
    userUpdateOneMock.mockResolvedValue({ acknowledged: true });

    const r = await approveReseller("res1", "admin1");
    expect(r.status).toBe("approved");
    expect(r.approvedBy).toBe("admin1");
    expect(save).toHaveBeenCalled();
    expect(userUpdateOneMock).toHaveBeenCalledWith({ _id: "user1" }, { $set: { role: "reseller" } });
  });

  it("throws NOT_FOUND (404) when the reseller is missing", async () => {
    resellerFindByIdMock.mockResolvedValue(null);
    await expect(approveReseller("nope", "admin1")).rejects.toBeInstanceOf(ResellerError);
    expect(userUpdateOneMock).not.toHaveBeenCalled();
  });
});

describe("suspendReseller", () => {
  it("sets status suspended", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    resellerFindByIdMock.mockResolvedValue({ _id: "res1", status: "approved", save });
    const r = await suspendReseller("res1");
    expect(r.status).toBe("suspended");
    expect(save).toHaveBeenCalled();
  });
});

describe("listResellers", () => {
  it("newest-first with owner populated", async () => {
    const lean = vi.fn().mockResolvedValue([{ _id: "res1" }]);
    const populate = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ populate });
    resellerFindMock.mockReturnValue({ sort });

    const rows = await listResellers();
    expect(resellerFindMock).toHaveBeenCalledWith({});
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(populate).toHaveBeenCalledWith("ownerUserId", "email firstName lastName role");
    expect(rows).toEqual([{ _id: "res1" }]);
  });
});
