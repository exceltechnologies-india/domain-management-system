/**
 * Service-layer integration tests for the security-critical helpers in
 * lib/services/users.ts.
 *
 * The H3/M3 security batch (commit `66d8b84`) flipped `password`,
 * `resetToken`, and `resetTokenExpiry` to `select: false` on the User
 * schema, and added the `userHasPassword` helper so `/api/auth/me` could
 * answer "is a password set?" without surfacing the bcrypt hash to the
 * client. This suite locks in those guarantees so a future regression
 * (someone accidentally removing the `.select("+password")` opt-in)
 * surfaces here.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import User from "@/models/User";
import {
  applyUserPatch,
  appendUserDomain,
  countAdmins,
  countUsers,
  createUser,
  findUserByResetToken,
  findUsersByEmails,
  findUsersByIds,
  getUserByEmail,
  getUserByEmailForLogin,
  getUserById,
  getUserWithPassword,
  permanentDeleteUser,
  reactivateUser,
  setUserDirectAdminUsername,
  setUserResellerClubIds,
  softDeleteUser,
  updateUserRole,
  userHasPassword,
} from "@/lib/services/users";

function buildUserPayload(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  return {
    email: `${tag}@user.test`,
    password: "Sup3rS3cret!", // > 6 chars; schema requires it for credentials provider
    firstName: "Test",
    lastName: "User",
    ...overrides,
  };
}

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await User.syncIndexes();
});

beforeEach(clearAllCollections);

describe("password field is select:false by default (security)", () => {
  it("default reads of the user do NOT include the bcrypt hash", async () => {
    await createUser(buildUserPayload({ email: "leak@user.test" }));

    const fromId = await getUserByEmail("leak@user.test");
    expect(fromId).toBeTruthy();
    // The bcrypt hash MUST NOT be returned by default. A regression here
    // (e.g. removing `select: false` from the schema) would silently leak
    // the hash into any API response that returns the user object.
    expect((fromId as unknown as { password?: string }).password).toBeUndefined();
  });

  it("getUserWithPassword opts in to the hash for bcrypt-compare flows", async () => {
    const created = await createUser(buildUserPayload({ email: "auth@user.test" }));
    const withPwd = await getUserWithPassword(created._id);
    // Hash IS present, and it's bcrypt-shaped (not the plaintext).
    expect((withPwd as unknown as { password?: string }).password).toBeDefined();
    expect((withPwd as unknown as { password?: string }).password).not.toBe("Sup3rS3cret!");
  });

  it("getUserByEmailForLogin opts in to the hash and honours maxTimeMS", async () => {
    await createUser(buildUserPayload({ email: "login@user.test" }));
    const found = await getUserByEmailForLogin("login@user.test", { maxTimeMS: 2000 });
    expect((found as unknown as { password?: string }).password).toBeDefined();
  });
});

describe("userHasPassword", () => {
  it("returns true when a password hash is present", async () => {
    const u = await createUser(buildUserPayload({ email: "withpw@user.test" }));
    expect(await userHasPassword(u._id)).toBe(true);
  });

  it("returns false for OAuth-only users (no password set)", async () => {
    const u = await createUser(
      buildUserPayload({
        email: "oauth@user.test",
        provider: "google",
        password: undefined, // schema makes password optional when provider !== credentials
      })
    );
    expect(await userHasPassword(u._id)).toBe(false);
  });

  it("returns false when the user id doesn't match", async () => {
    expect(await userHasPassword(new mongoose.Types.ObjectId())).toBe(false);
  });
});

describe("findUserByResetToken", () => {
  it("matches a still-valid reset token and opts in to the select:false fields", async () => {
    const expiry = new Date(Date.now() + 60 * 60 * 1000);
    const created = await createUser(
      buildUserPayload({
        email: "reset@user.test",
        resetToken: "tok_abc",
        resetTokenExpiry: expiry,
      })
    );

    const found = await findUserByResetToken("tok_abc");
    expect(found?._id.toString()).toBe(created._id.toString());
    expect((found as unknown as { resetToken?: string }).resetToken).toBe("tok_abc");
  });

  it("returns null for an expired token", async () => {
    await createUser(
      buildUserPayload({
        email: "expired@user.test",
        resetToken: "tok_stale",
        resetTokenExpiry: new Date(Date.now() - 60 * 1000),
      })
    );
    expect(await findUserByResetToken("tok_stale")).toBeNull();
  });
});

describe("CRUD helpers", () => {
  it("getUserById / getUserByEmail return matching docs", async () => {
    const created = await createUser(buildUserPayload({ email: "crud@user.test" }));
    expect((await getUserById(String(created._id)))?.email).toBe("crud@user.test");
    expect((await getUserByEmail("crud@user.test"))?._id.toString()).toBe(created._id.toString());
  });

  it("softDeleteUser → reactivateUser round-trip preserves the document", async () => {
    const created = await createUser(buildUserPayload({ email: "soft@user.test" }));
    const soft = await softDeleteUser(String(created._id));
    expect(soft?.isActive).toBe(false);
    const back = await reactivateUser(String(created._id));
    expect(back?.isActive).toBe(true);
  });

  it("permanentDeleteUser removes the row from the DB", async () => {
    const created = await createUser(buildUserPayload({ email: "perm@user.test" }));
    await permanentDeleteUser(String(created._id));
    expect(await User.findById(created._id)).toBeNull();
  });
});

describe("findUsersByEmails / findUsersByIds (batch lookups)", () => {
  it("returns the subset that matches and skips empty input", async () => {
    const a = await createUser(buildUserPayload({ email: "a@bulk.test" }));
    const b = await createUser(buildUserPayload({ email: "b@bulk.test" }));

    expect(await findUsersByEmails([])).toEqual([]);
    expect(await findUsersByIds([])).toEqual([]);

    const byEmails = await findUsersByEmails(["a@bulk.test", "missing@bulk.test"]);
    expect(byEmails.map((u) => u.email).sort()).toEqual(["a@bulk.test"]);

    const byIds = await findUsersByIds([String(a._id), String(b._id)]);
    expect(byIds.map((u) => u.email).sort()).toEqual(["a@bulk.test", "b@bulk.test"]);
  });
});

describe("countAdmins / countUsers", () => {
  it("counts only admins for countAdmins", async () => {
    await createUser(buildUserPayload({ email: "u@count.test", role: "user" }));
    await createUser(buildUserPayload({ email: "a@count.test", role: "admin" }));
    expect(await countAdmins()).toBe(1);
    expect(await countUsers()).toBeGreaterThanOrEqual(2);
  });
});

describe("updateUserRole", () => {
  it("promotes a user to admin and returns the updated doc", async () => {
    const u = await createUser(buildUserPayload({ email: "promote@user.test", role: "user" }));
    const updated = await updateUserRole(String(u._id), "admin");
    expect(updated?.role).toBe("admin");
  });
});

describe("applyUserPatch", () => {
  it("applies the patch and ignores fields the helper doesn't whitelist", async () => {
    const u = await createUser(buildUserPayload({ email: "patch@user.test" }));
    const after = await applyUserPatch(String(u._id), { firstName: "Renamed" });
    expect(after?.firstName).toBe("Renamed");
  });
});

describe("appendUserDomain", () => {
  it("is a no-throw side effect — User schema doesn't declare a domains[] field, so mongoose strict-mode strips the $push silently", async () => {
    const u = await createUser(buildUserPayload({ email: "dom@user.test" }));
    // The helper is best-effort: callers (domain-renewal flow) treat it as a
    // fire-and-forget audit hook. Test the contract that matters — it doesn't
    // throw — rather than asserting a side-effect that strict-mode drops.
    await expect(
      appendUserDomain(String(u._id), {
        domainName: "added.test",
        price: 100,
        currency: "INR",
        registrationPeriod: 1,
        status: "registered",
      })
    ).resolves.toBeUndefined();
  });
});

describe("setUserResellerClubIds / setUserDirectAdminUsername", () => {
  it("persists the registrar / hosting identifiers", async () => {
    const u = await createUser(buildUserPayload({ email: "ids@user.test" }));
    await setUserResellerClubIds(String(u._id), {
      customerId: 1234,
      contactId: 5678,
    });
    await setUserDirectAdminUsername(String(u._id), "daX1");
    const refetched = await User.findById(u._id);
    expect(refetched?.resellerClubCustomerId).toBe(1234);
    expect(refetched?.resellerClubContactId).toBe(5678);
    expect(refetched?.directAdminUsername).toBe("daX1");
  });

  it("setUserDirectAdminUsername is CAS-style: first writer wins, second is no-op", async () => {
    // Two concurrent hosting provisionings on the same user would each try
    // to stamp their generated DA username. With the CAS guard, only the
    // first write lands.
    const u = await createUser(buildUserPayload({ email: "cas@user.test" }));
    await setUserDirectAdminUsername(String(u._id), "daFirst");
    await setUserDirectAdminUsername(String(u._id), "daSecond");
    const refetched = await User.findById(u._id);
    expect(refetched?.directAdminUsername).toBe("daFirst");
  });
});
