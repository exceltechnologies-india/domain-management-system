/**
 * Tests for `@/lib/services/users` (rescan-4 slice 7fu). The single
 * place route handlers reach for User-collection operations.
 *
 * The service module exposes 50+ functions; this test focuses on the
 * **security-critical and contract-pinning** paths rather than line
 * coverage of every Mongoose passthrough. Pins:
 *  - **createUserWithCredentials role hardcode**: role:'user', NEVER
 *    admin (registration path can't escalate); provider:'credentials',
 *    isActivated:false; optional profile fields spread conditionally
 *    (no `undefined` writes that would override schema defaults)
 *  - **softDeleteUser revokes sessions**: also stamps
 *    sessionInvalidatedAt=now (mandatory session-revoke pairs with
 *    isActive=false; otherwise the user could keep using their old
 *    JWT after being deactivated)
 *  - **applyUserPatch role whitelist**: only 'user' / 'admin' accepted
 *    (anti-mass-assignment); isActive true→false sets
 *    sessionInvalidatedAt; false→true clears it
 *  - **resetUser2FA revokes sessions** (admin-initiated → revoke);
 *    **disableTOTPForUser does NOT revoke** (user-initiated, keep
 *    sessions)
 *  - **setUserDirectAdminUsername is CAS-style**: only updates when
 *    field unset/null/empty (first writer wins on concurrent
 *    multi-hosting provisioning; the per-Hosting row still carries
 *    its own DA username so per-account mapping isn't lost)
 *  - **findUserByActivationToken expiry gate**: default future-only,
 *    onlyExpired:true flips to $lte:now (so the UI can show 'token
 *    expired' instead of generic 'invalid token')
 *  - **findUserByResetToken / findUserByPendingEmailToken opt-in to
 *    select:false fields** (resetToken/pendingEmail* are normally
 *    excluded — these are the only places they're allowed back)
 *  - **getUserByEmailForLogin**: opts in `+password` + maxTimeMS cap
 *    default 5000 (NextAuth authorize callback has tight latency
 *    budget — a slow primary can't stall login forever)
 *  - **findUsersByIds / findUsersByEmails empty-array short-circuit**:
 *    no DB call when ids/emails is [] (anti-foot-gun — Mongo's $in:[]
 *    matches nothing, but skipping is cheaper)
 *  - **setUserResellerClubIds empty patch → NO DB call** (anti-empty
 *    update)
 *  - **getUserCart**: returns [] for missing user (caller never
 *    null-checks the array)
 *  - **listUsers defaults**: filter `{role: {$ne: 'admin'}, isDeleted:
 *    {$ne: true}}`, page 1, limit 50, sort createdAt:-1; pagination
 *    math: skip=(page-1)*limit, totalPages=ceil(total/limit) or 0
 *  - **getUserForTokenRefresh + getUserForSessionCheck projection**:
 *    exact field lists (security-hot-path — these run on EVERY
 *    authenticated request via the NextAuth callbacks)
 *  - **invalidateUserSessionNow** stamps BOTH sessionInvalidatedAt
 *    AND lastActivityAt (the latter so the next legitimate sign-in
 *    starts a fresh window, not an immediately-stale one)
 *  - **clearDirectAdminUsernameForAll** returns modifiedCount (null/
 *    undefined modifiedCount → 0)
 *  - **permanentDeleteUser** snapshots userName/userEmail onto orders
 *    where it's currently absent BEFORE deleting (audit trail must
 *    survive deletion); snapshot failure does NOT block deletion
 *    (admin already authorised the destructive action)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const User = vi.hoisted(() => ({
  findById: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  findByIdAndUpdate: vi.fn(),
  findByIdAndDelete: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  countDocuments: vi.fn(),
  aggregate: vi.fn(),
}));
vi.mock("@/models/User", () => ({ default: User }));

const Order = vi.hoisted(() => ({
  updateMany: vi.fn(),
}));
vi.mock("@/models/Order", () => ({ default: Order }));

import {
  getUserById,
  getUserByEmail,
  findAnyAdmin,
  findUsersByIds,
  findUsersByEmails,
  listUsersWithDirectAdmin,
  getUserCart,
  setUserCart,
  clearUserCart,
  findUserRoleById,
  countAdmins,
  countUsers,
  listUsers,
  updateUserRole,
  softDeleteUser,
  permanentDeleteUser,
  applyUserPatch,
  reactivateUser,
  resetUser2FA,
  clearDirectAdminUsernameForAll,
  appendUserDomain,
  createUser,
  createUserWithCredentials,
  setUserResellerClubIds,
  setUserDirectAdminUsername,
  findUserByActivationToken,
  findUserByResetToken,
  findUserByPendingEmailToken,
  findUserByEmailExcluding,
  getUserWithPendingTOTP,
  getUserWithTOTPSecrets,
  setPendingTOTPSecret,
  activateTOTPForUser,
  disableTOTPForUser,
  consumeUserBackupCode,
  getUserWithPassword,
  userHasPassword,
  getUserForTokenRefresh,
  getUserForSessionCheck,
  getUserByEmailForLogin,
  updateUserLastActivity,
  invalidateUserSessionNow,
  listUsersWithServicesAggregation,
} from "@/lib/services/users";

function chainQuery(finalResolved: unknown) {
  const q: any = {
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockReturnThis(),
    maxTimeMS: vi.fn().mockReturnThis(),
    then: (resolve: (v: unknown) => void) => resolve(finalResolved),
  };
  return q;
}

beforeEach(() => {
  Object.values(User).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockReset());
  Order.updateMany.mockReset();
  connectDB.mockReset();
});

// ── Reads ────────────────────────────────────────────────────────────
describe("getUserById / getUserByEmail / findAnyAdmin — thin reads", () => {
  it("getUserById: findById passthrough", async () => {
    User.findById.mockResolvedValueOnce({ _id: "U1" });
    await getUserById("U1");
    expect(User.findById).toHaveBeenCalledWith("U1");
    expect(connectDB).toHaveBeenCalled();
  });

  it("getUserByEmail: findOne with email filter", async () => {
    User.findOne.mockResolvedValueOnce({});
    await getUserByEmail("u@x.com");
    expect(User.findOne).toHaveBeenCalledWith({ email: "u@x.com" });
  });

  it("findAnyAdmin: findOne with role:'admin'", async () => {
    User.findOne.mockResolvedValueOnce(null);
    expect(await findAnyAdmin()).toBeNull();
    expect(User.findOne).toHaveBeenCalledWith({ role: "admin" });
  });
});

describe("findUsersByIds / findUsersByEmails — short-circuit + projection", () => {
  it("findUsersByIds: empty array → [] (NO DB call)", async () => {
    expect(await findUsersByIds([])).toEqual([]);
    expect(User.find).not.toHaveBeenCalled();
    expect(connectDB).not.toHaveBeenCalled();
  });

  it("findUsersByIds: default projection = `_id email firstName lastName`", async () => {
    const q = chainQuery([]);
    User.find.mockReturnValueOnce(q);
    await findUsersByIds(["A", "B"]);
    expect(User.find).toHaveBeenCalledWith({ _id: { $in: ["A", "B"] } });
    expect(q.select).toHaveBeenCalledWith("_id email firstName lastName");
  });

  it("findUsersByIds: extraFields concat into projection", async () => {
    const q = chainQuery([]);
    User.find.mockReturnValueOnce(q);
    await findUsersByIds(["A"], "role isActive");
    expect(q.select).toHaveBeenCalledWith(
      "_id email firstName lastName role isActive"
    );
  });

  it("findUsersByEmails: empty array → [] (NO DB call)", async () => {
    expect(await findUsersByEmails([])).toEqual([]);
    expect(User.find).not.toHaveBeenCalled();
  });

  it("findUsersByEmails: $in filter on email", async () => {
    const q = chainQuery([]);
    User.find.mockReturnValueOnce(q);
    await findUsersByEmails(["a@x.com", "b@x.com"]);
    expect(User.find).toHaveBeenCalledWith({
      email: { $in: ["a@x.com", "b@x.com"] },
    });
  });
});

describe("listUsersWithDirectAdmin — DA-linked users", () => {
  it("filter: directAdminUsername $exists + $ne null", async () => {
    const q = chainQuery([]);
    User.find.mockReturnValueOnce(q);
    await listUsersWithDirectAdmin();
    expect(User.find).toHaveBeenCalledWith({
      directAdminUsername: { $exists: true, $ne: null },
    });
  });
});

describe("getUserCart / setUserCart / clearUserCart", () => {
  it("getUserCart: missing user → [] (anti-null-check)", async () => {
    const q = chainQuery(null);
    User.findById.mockReturnValueOnce(q);
    expect(await getUserCart("U1")).toEqual([]);
  });

  it("getUserCart: present → cart array verbatim", async () => {
    const q = chainQuery({ cart: [{ id: "X" }] });
    User.findById.mockReturnValueOnce(q);
    expect(await getUserCart("U1")).toEqual([{ id: "X" }]);
  });

  it("getUserCart: doc found but cart field absent → []", async () => {
    const q = chainQuery({});
    User.findById.mockReturnValueOnce(q);
    expect(await getUserCart("U1")).toEqual([]);
  });

  it("setUserCart: findByIdAndUpdate with { cart }", async () => {
    await setUserCart("U1", [{ id: "X" }]);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith("U1", {
      cart: [{ id: "X" }],
    });
  });

  it("clearUserCart: setUserCart([]) delegation", async () => {
    await clearUserCart("U1");
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith("U1", { cart: [] });
  });
});

describe("findUserRoleById / countAdmins / countUsers — light reads", () => {
  it("findUserRoleById: findById.select('role').lean()", async () => {
    const q = chainQuery({ role: "admin" });
    User.findById.mockReturnValueOnce(q);
    await findUserRoleById("U1");
    expect(q.select).toHaveBeenCalledWith("role");
    expect(q.lean).toHaveBeenCalled();
  });

  it("countAdmins: countDocuments role:'admin'", async () => {
    User.countDocuments.mockResolvedValueOnce(3);
    expect(await countAdmins()).toBe(3);
    expect(User.countDocuments).toHaveBeenCalledWith({ role: "admin" });
  });

  it("countUsers: default {} filter; user-supplied filter forwarded", async () => {
    User.countDocuments.mockResolvedValueOnce(10);
    await countUsers();
    expect(User.countDocuments).toHaveBeenLastCalledWith({});
    User.countDocuments.mockResolvedValueOnce(2);
    await countUsers({ isActive: true });
    expect(User.countDocuments).toHaveBeenLastCalledWith({ isActive: true });
  });
});

// ── listUsers (paginated admin list) ─────────────────────────────────
describe("listUsers — paginated admin list", () => {
  function setupList(rows: unknown[], total: number) {
    const q = chainQuery(rows);
    User.find.mockReturnValueOnce(q);
    User.countDocuments.mockResolvedValueOnce(total);
    return q;
  }

  it("defaults: filter excludes admins + deleted; page=1, limit=50; sort createdAt:-1", async () => {
    const q = setupList([], 0);
    await listUsers();
    expect(User.find).toHaveBeenCalledWith(
      { role: { $ne: "admin" }, isDeleted: { $ne: true } },
      expect.any(Object) // projection
    );
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(q.skip).toHaveBeenCalledWith(0);
    expect(q.limit).toHaveBeenCalledWith(50);
  });

  it("page=3 limit=10 → skip=20", async () => {
    const q = setupList([], 0);
    await listUsers({ page: 3, limit: 10 });
    expect(q.skip).toHaveBeenCalledWith(20);
    expect(q.limit).toHaveBeenCalledWith(10);
  });

  it("result shape: users + total + page + limit + totalPages + hasMore", async () => {
    setupList([], 25);
    const r = await listUsers({ page: 2, limit: 10 });
    expect(r.users).toEqual([]);
    expect(r.total).toBe(25);
    expect(r.totalPages).toBe(3); // ceil(25/10)
    expect(r.hasMore).toBe(true);
  });

  it("totalPages = 0 when total=0 (Math.ceil(0)|| 0)", async () => {
    setupList([], 0);
    const r = await listUsers();
    expect(r.totalPages).toBe(0);
  });

  it("hasMore false on last page", async () => {
    setupList([], 25);
    const r = await listUsers({ page: 3, limit: 10 });
    expect(r.hasMore).toBe(false); // 3*10=30 < 25 is false
  });
});

// ── Writes ───────────────────────────────────────────────────────────
describe("updateUserRole", () => {
  it("findByIdAndUpdate with {role} + new:true + lean projection", async () => {
    const q = { lean: vi.fn().mockResolvedValueOnce({ role: "admin" }) };
    User.findByIdAndUpdate.mockReturnValueOnce(q);
    await updateUserRole("U1", "admin");
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
      "U1",
      { role: "admin" },
      { new: true, select: "firstName lastName email role" }
    );
  });
});

describe("softDeleteUser — MUST also revoke sessions", () => {
  it("sets isActive:false + isDeleted:true + deletedAt + **sessionInvalidatedAt**", async () => {
    User.findByIdAndUpdate.mockResolvedValueOnce({});
    await softDeleteUser("U1");
    const [, update, opts] = User.findByIdAndUpdate.mock.calls[0];
    expect(update.isActive).toBe(false);
    expect(update.isDeleted).toBe(true);
    expect(update.deletedAt).toBeInstanceOf(Date);
    expect(update.sessionInvalidatedAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ new: true });
  });
});

describe("permanentDeleteUser — snapshot-then-delete", () => {
  it("snapshots userName + userEmail onto orders that don't have userName, then deletes", async () => {
    const q = chainQuery({
      firstName: "First",
      lastName: "Last",
      email: "u@x.com",
    });
    User.findById.mockReturnValueOnce(q);
    Order.updateMany.mockResolvedValueOnce({ modifiedCount: 3 });
    User.findByIdAndDelete.mockResolvedValueOnce({});

    const r = await permanentDeleteUser("U1");

    expect(Order.updateMany).toHaveBeenCalledWith(
      {
        userId: "U1",
        $or: [{ userName: { $exists: false } }, { userName: "" }],
      },
      { $set: { userName: "First Last", userEmail: "u@x.com" } }
    );
    expect(User.findByIdAndDelete).toHaveBeenCalledWith("U1");
    expect(r.ordersSnapshotted).toBe(3);
  });

  it("snapshot failure does NOT block deletion (admin already authorised)", async () => {
    User.findById.mockReturnValueOnce({
      select: vi.fn().mockReturnValueOnce({
        lean: vi.fn().mockRejectedValueOnce(new Error("DB outage")),
      }),
    });
    User.findByIdAndDelete.mockResolvedValueOnce({});

    const r = await permanentDeleteUser("U1");

    expect(User.findByIdAndDelete).toHaveBeenCalledWith("U1");
    expect(r.ordersSnapshotted).toBe(0);
  });

  it("missing modifiedCount → 0 (defensive default)", async () => {
    const q = chainQuery({ firstName: "F", lastName: "L", email: "u@x.com" });
    User.findById.mockReturnValueOnce(q);
    Order.updateMany.mockResolvedValueOnce({}); // no modifiedCount field
    User.findByIdAndDelete.mockResolvedValueOnce({});

    const r = await permanentDeleteUser("U1");
    expect(r.ordersSnapshotted).toBe(0);
  });
});

describe("applyUserPatch — role whitelist + session-invalidate transition", () => {
  function makeUser(over: Partial<any> = {}) {
    return {
      firstName: "F",
      lastName: "L",
      email: "u@x.com",
      role: "user",
      isActive: true,
      save: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  it("user not found → null", async () => {
    User.findById.mockResolvedValueOnce(null);
    expect(await applyUserPatch("U1", { firstName: "X" })).toBeNull();
  });

  it("**role whitelist**: only 'user' / 'admin' accepted (anti-mass-assignment)", async () => {
    const user = makeUser();
    User.findById.mockResolvedValueOnce(user);
    await applyUserPatch("U1", { role: "superadmin" as any });
    expect(user.role).toBe("user"); // unchanged
  });

  it("role 'admin' accepted (whitelisted)", async () => {
    const user = makeUser();
    User.findById.mockResolvedValueOnce(user);
    await applyUserPatch("U1", { role: "admin" });
    expect(user.role).toBe("admin");
  });

  it("isActive true→false: sets sessionInvalidatedAt (session-revoke pair)", async () => {
    const user = makeUser({ isActive: true });
    User.findById.mockResolvedValueOnce(user);
    await applyUserPatch("U1", { isActive: false });
    expect(user.isActive).toBe(false);
    expect((user as any).sessionInvalidatedAt).toBeInstanceOf(Date);
  });

  it("isActive false→true: CLEARS sessionInvalidatedAt (re-enable allows login)", async () => {
    const user = makeUser({ isActive: false });
    User.findById.mockResolvedValueOnce(user);
    await applyUserPatch("U1", { isActive: true });
    expect(user.isActive).toBe(true);
    expect((user as any).sessionInvalidatedAt).toBeNull();
  });

  it("isActive unchanged → sessionInvalidatedAt NOT touched", async () => {
    const user = makeUser({ isActive: true });
    User.findById.mockResolvedValueOnce(user);
    await applyUserPatch("U1", { isActive: true }); // same as wasActive
    expect((user as any).sessionInvalidatedAt).toBeUndefined();
  });

  it("calls user.save() to fire pre-save hooks (e.g. password re-hash)", async () => {
    const user = makeUser();
    User.findById.mockResolvedValueOnce(user);
    await applyUserPatch("U1", { firstName: "New" });
    expect(user.save).toHaveBeenCalled();
    expect(user.firstName).toBe("New");
  });
});

describe("reactivateUser", () => {
  it("flips isActive, isDeleted, clears deletedAt + sessionInvalidatedAt", async () => {
    User.findByIdAndUpdate.mockResolvedValueOnce({});
    await reactivateUser("U1");
    const [, update] = User.findByIdAndUpdate.mock.calls[0];
    expect(update).toEqual({
      isActive: true,
      isDeleted: false,
      deletedAt: null,
      sessionInvalidatedAt: null,
    });
  });
});

describe("resetUser2FA — admin-initiated REVOKES sessions", () => {
  it("clears TOTP fields + **stamps sessionInvalidatedAt** (admin recovery → revoke)", async () => {
    await resetUser2FA("U1");
    const [, update] = User.findByIdAndUpdate.mock.calls[0];
    expect(update.$set).toMatchObject({ totpEnabled: false });
    expect(update.$set.sessionInvalidatedAt).toBeInstanceOf(Date);
    expect(update.$unset).toEqual({
      totpSecret: "",
      totpSecretPending: "",
      totpBackupCodes: "",
    });
  });
});

describe("disableTOTPForUser — user-initiated does NOT revoke", () => {
  it("clears TOTP fields but does NOT stamp sessionInvalidatedAt", async () => {
    await disableTOTPForUser("U1");
    const [, update] = User.updateOne.mock.calls[0];
    expect(update.$set).toEqual({ totpEnabled: false });
    expect(update.$set).not.toHaveProperty("sessionInvalidatedAt");
    expect(update.$unset).toEqual({
      totpSecret: "",
      totpSecretPending: "",
      totpBackupCodes: "",
    });
  });
});

describe("clearDirectAdminUsernameForAll", () => {
  it("$unset directAdminUsername where matches username; returns modifiedCount", async () => {
    User.updateMany.mockResolvedValueOnce({ modifiedCount: 5 });
    const r = await clearDirectAdminUsernameForAll("alice");
    expect(User.updateMany).toHaveBeenCalledWith(
      { directAdminUsername: "alice" },
      { $unset: { directAdminUsername: "" } }
    );
    expect(r).toBe(5);
  });

  it("missing modifiedCount → 0 (defensive default)", async () => {
    User.updateMany.mockResolvedValueOnce({});
    expect(await clearDirectAdminUsernameForAll("alice")).toBe(0);
  });
});

describe("appendUserDomain — legacy embedded-domain push", () => {
  it("$push onto domains array", async () => {
    await appendUserDomain("U1", { domainName: "x.com" });
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith("U1", {
      $push: { domains: { domainName: "x.com" } },
    });
  });
});

describe("createUser / createUserWithCredentials — registration", () => {
  it("createUser: thin passthrough to .create()", async () => {
    User.create.mockResolvedValueOnce({ _id: "NEW" });
    await createUser({ email: "x@y.com" });
    expect(User.create).toHaveBeenCalledWith({ email: "x@y.com" });
  });

  it("**createUserWithCredentials hardcodes role:'user'** (registration CANNOT escalate)", async () => {
    User.create.mockResolvedValueOnce({});
    await createUserWithCredentials({
      email: "u@x.com",
      password: "hash",
      firstName: "First",
      lastName: "Last",
      activationToken: "T",
      activationTokenExpiry: new Date(),
      profileCompleted: false,
    });
    const payload = User.create.mock.calls[0][0];
    expect(payload.role).toBe("user");
    expect(payload.provider).toBe("credentials");
    expect(payload.isActivated).toBe(false);
  });

  it("optional fields use conditional spread (NO undefined writes)", async () => {
    User.create.mockResolvedValueOnce({});
    await createUserWithCredentials({
      email: "u@x.com",
      password: "hash",
      firstName: "F",
      lastName: "L",
      activationToken: "T",
      activationTokenExpiry: new Date(),
      profileCompleted: false,
      // phone, phoneCc, companyName, gstNumber, address ALL omitted
    });
    const payload = User.create.mock.calls[0][0];
    expect(payload).not.toHaveProperty("phone");
    expect(payload).not.toHaveProperty("phoneCc");
    expect(payload).not.toHaveProperty("companyName");
    expect(payload).not.toHaveProperty("gstNumber");
    expect(payload).not.toHaveProperty("address");
  });

  it("optional fields present → spread in payload", async () => {
    User.create.mockResolvedValueOnce({});
    const address = {
      line1: "1 St",
      city: "City",
      state: "St",
      country: "Co",
      zipcode: "00",
    };
    await createUserWithCredentials({
      email: "u@x.com",
      password: "hash",
      firstName: "F",
      lastName: "L",
      phone: "9876543210",
      phoneCc: "+91",
      companyName: "Acme",
      gstNumber: "27AABCU9603R1ZW",
      address,
      activationToken: "T",
      activationTokenExpiry: new Date(),
      profileCompleted: true,
    });
    const payload = User.create.mock.calls[0][0];
    expect(payload.phone).toBe("9876543210");
    expect(payload.phoneCc).toBe("+91");
    expect(payload.companyName).toBe("Acme");
    expect(payload.gstNumber).toBe("27AABCU9603R1ZW");
    expect(payload.address).toEqual(address);
    expect(payload.profileCompleted).toBe(true);
  });
});

describe("setUserResellerClubIds — empty-patch short-circuit", () => {
  it("both ids undefined → NO DB call", async () => {
    await setUserResellerClubIds("U1", {});
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(connectDB).not.toHaveBeenCalled();
  });

  it("only customerId → writes only that field", async () => {
    await setUserResellerClubIds("U1", { customerId: 100 });
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "U1" },
      { $set: { resellerClubCustomerId: 100 } }
    );
  });

  it("only contactId → writes only that field", async () => {
    await setUserResellerClubIds("U1", { contactId: 200 });
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "U1" },
      { $set: { resellerClubContactId: 200 } }
    );
  });

  it("both → writes both fields in one update", async () => {
    await setUserResellerClubIds("U1", { customerId: 1, contactId: 2 });
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "U1" },
      { $set: { resellerClubCustomerId: 1, resellerClubContactId: 2 } }
    );
  });
});

describe("setUserDirectAdminUsername — **CAS-style first-writer-wins**", () => {
  it("filter requires _id AND (field unset / null / empty) — concurrent loser is a no-op", async () => {
    await setUserDirectAdminUsername("U1", "alice");
    const [filter, update] = User.updateOne.mock.calls[0];
    expect(filter._id).toBe("U1");
    expect(filter.$or).toEqual([
      { directAdminUsername: { $exists: false } },
      { directAdminUsername: null },
      { directAdminUsername: "" },
    ]);
    expect(update).toEqual({ $set: { directAdminUsername: "alice" } });
  });
});

// ── Token-based lookups ─────────────────────────────────────────────
describe("findUserByActivationToken — expiry gate flip", () => {
  it("default: future-only (activationTokenExpiry > now)", async () => {
    User.findOne.mockResolvedValueOnce(null);
    await findUserByActivationToken("T1");
    const filter = User.findOne.mock.calls[0][0];
    expect(filter.activationToken).toBe("T1");
    expect(filter.activationTokenExpiry).toHaveProperty("$gt");
  });

  it("onlyExpired:true → past-only ($lte:now) for 'token expired' error", async () => {
    User.findOne.mockResolvedValueOnce(null);
    await findUserByActivationToken("T1", { onlyExpired: true });
    const filter = User.findOne.mock.calls[0][0];
    expect(filter.activationTokenExpiry).toHaveProperty("$lte");
  });
});

describe("findUserByResetToken / findUserByPendingEmailToken — opt-in select", () => {
  it("findUserByResetToken: future-expiry filter + opts in +resetToken +resetTokenExpiry", async () => {
    const q = { select: vi.fn().mockResolvedValueOnce(null) };
    User.findOne.mockReturnValueOnce(q);
    await findUserByResetToken("T1");
    expect(User.findOne.mock.calls[0][0].resetTokenExpiry).toHaveProperty("$gt");
    expect(q.select).toHaveBeenCalledWith("+resetToken +resetTokenExpiry");
  });

  it("findUserByPendingEmailToken: opts in +pendingEmailToken +pendingEmail +pendingEmailExpiry", async () => {
    const q = { select: vi.fn().mockResolvedValueOnce(null) };
    User.findOne.mockReturnValueOnce(q);
    await findUserByPendingEmailToken("HASH");
    expect(q.select).toHaveBeenCalledWith(
      "+pendingEmailToken +pendingEmail +pendingEmailExpiry"
    );
  });
});

describe("findUserByEmailExcluding — uniqueness conflict check", () => {
  it("filter: email + _id $ne excluded", async () => {
    User.findOne.mockResolvedValueOnce(null);
    await findUserByEmailExcluding("u@x.com", "U1");
    expect(User.findOne).toHaveBeenCalledWith({
      email: "u@x.com",
      _id: { $ne: "U1" },
    });
  });
});

// ── TOTP (auth-internal) ────────────────────────────────────────────
describe("TOTP secret accessors — opt-in select fields", () => {
  it("getUserWithPendingTOTP: opts in +totpSecretPending", async () => {
    const q = { select: vi.fn().mockResolvedValueOnce(null) };
    User.findById.mockReturnValueOnce(q);
    await getUserWithPendingTOTP("U1");
    expect(q.select).toHaveBeenCalledWith("+totpSecretPending totpEnabled");
  });

  it("getUserWithTOTPSecrets: opts in +totpSecret +totpBackupCodes +password (disable flow needs all three)", async () => {
    const q = { select: vi.fn().mockResolvedValueOnce(null) };
    User.findById.mockReturnValueOnce(q);
    await getUserWithTOTPSecrets("U1");
    expect(q.select).toHaveBeenCalledWith(
      "+totpSecret +totpBackupCodes +password totpEnabled"
    );
  });

  it("setPendingTOTPSecret: $set on totpSecretPending only", async () => {
    await setPendingTOTPSecret("U1", "SECRET");
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "U1" },
      { $set: { totpSecretPending: "SECRET" } }
    );
  });

  it("activateTOTPForUser: $set { totpEnabled, totpSecret, totpBackupCodes } + $unset totpSecretPending", async () => {
    await activateTOTPForUser("U1", {
      secret: "S",
      hashedBackupCodes: ["h1", "h2"],
    });
    const [, update] = User.updateOne.mock.calls[0];
    expect(update.$set).toEqual({
      totpEnabled: true,
      totpSecret: "S",
      totpBackupCodes: ["h1", "h2"],
    });
    expect(update.$unset).toEqual({ totpSecretPending: "" });
  });

  it("consumeUserBackupCode: $pull on hash", async () => {
    await consumeUserBackupCode("U1", "HASH");
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "U1" },
      { $pull: { totpBackupCodes: "HASH" } }
    );
  });
});

// ── Password + session lifecycle ─────────────────────────────────────
describe("getUserWithPassword + userHasPassword", () => {
  it("getUserWithPassword: opts in +password", async () => {
    const q = { select: vi.fn().mockResolvedValueOnce(null) };
    User.findById.mockReturnValueOnce(q);
    await getUserWithPassword("U1");
    expect(q.select).toHaveBeenCalledWith("+password");
  });

  it("userHasPassword: opts in +password, .lean(), returns boolean from password presence", async () => {
    const q = chainQuery({ password: "hash" });
    User.findById.mockReturnValueOnce(q);
    expect(await userHasPassword("U1")).toBe(true);
  });

  it("userHasPassword: missing user → false", async () => {
    const q = chainQuery(null);
    User.findById.mockReturnValueOnce(q);
    expect(await userHasPassword("U1")).toBe(false);
  });

  it("userHasPassword: user with no password field → false", async () => {
    const q = chainQuery({});
    User.findById.mockReturnValueOnce(q);
    expect(await userHasPassword("U1")).toBe(false);
  });
});

describe("getUserForTokenRefresh + getUserForSessionCheck — hot-path projections", () => {
  it("getUserForTokenRefresh: exact 5-field projection", async () => {
    const q = { select: vi.fn().mockResolvedValueOnce(null) };
    User.findById.mockReturnValueOnce(q);
    await getUserForTokenRefresh("U1");
    expect(q.select).toHaveBeenCalledWith(
      "isActive role sessionInvalidatedAt passwordChangedAt profileCompleted"
    );
  });

  it("getUserForSessionCheck: minimal 2-field projection (runs on EVERY authenticated request)", async () => {
    const q = { select: vi.fn().mockResolvedValueOnce(null) };
    User.findById.mockReturnValueOnce(q);
    await getUserForSessionCheck("U1");
    expect(q.select).toHaveBeenCalledWith("isActive sessionInvalidatedAt");
  });
});

describe("getUserByEmailForLogin — opts-in password + maxTimeMS cap", () => {
  it("default cap 5000ms (tight latency budget for NextAuth authorize)", async () => {
    const q = chainQuery(null);
    User.findOne.mockReturnValueOnce(q);
    await getUserByEmailForLogin("u@x.com");
    expect(q.select).toHaveBeenCalledWith("+password");
    expect(q.maxTimeMS).toHaveBeenCalledWith(5000);
  });

  it("explicit maxTimeMS override flows through", async () => {
    const q = chainQuery(null);
    User.findOne.mockReturnValueOnce(q);
    await getUserByEmailForLogin("u@x.com", { maxTimeMS: 1000 });
    expect(q.maxTimeMS).toHaveBeenCalledWith(1000);
  });
});

describe("updateUserLastActivity + invalidateUserSessionNow", () => {
  it("updateUserLastActivity: updateOne with lastActivityAt", async () => {
    const at = new Date("2026-01-01");
    await updateUserLastActivity("U1", at);
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: "U1" },
      { lastActivityAt: at }
    );
  });

  it("updateUserLastActivity: default 'at' is now (Date instance)", async () => {
    await updateUserLastActivity("U1");
    const [, update] = User.updateOne.mock.calls[0];
    expect(update.lastActivityAt).toBeInstanceOf(Date);
  });

  it("**invalidateUserSessionNow stamps BOTH sessionInvalidatedAt AND lastActivityAt**", async () => {
    await invalidateUserSessionNow("U1");
    const [, update] = User.findByIdAndUpdate.mock.calls[0];
    expect(update.sessionInvalidatedAt).toBeInstanceOf(Date);
    expect(update.lastActivityAt).toBeInstanceOf(Date);
  });
});

// ── Aggregation ──────────────────────────────────────────────────────
describe("listUsersWithServicesAggregation — pipeline shape", () => {
  it("matches non-deleted users + lookups domains + hostings + filters those with at least one + sort createdAt:-1", async () => {
    User.aggregate.mockResolvedValueOnce([]);
    await listUsersWithServicesAggregation();
    const pipeline = User.aggregate.mock.calls[0][0];

    expect(pipeline[0]).toEqual({ $match: { isDeleted: { $ne: true } } });
    expect(pipeline[1]).toMatchObject({
      $lookup: {
        from: "domains",
        localField: "_id",
        foreignField: "userId",
        as: "domains",
      },
    });
    expect(pipeline[2]).toMatchObject({
      $lookup: {
        from: "hostings",
        localField: "_id",
        foreignField: "userId",
        as: "hosting",
      },
    });
    // second $match keeps users with at least one domain OR hosting
    expect(pipeline[3].$match.$or).toEqual([
      { "domains.0": { $exists: true } },
      { "hosting.0": { $exists: true } },
    ]);
    expect(pipeline[pipeline.length - 1]).toEqual({
      $sort: { createdAt: -1 },
    });
  });
});
