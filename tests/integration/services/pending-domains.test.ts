/**
 * Service-layer integration tests for lib/services/pending-domains.ts.
 *
 * Covers user-side reads (active list / lookups) + admin lookups by id
 * including the legacy raw-string-_id $or branch.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import PendingDomain from "@/models/PendingDomain";
// Importing the User model for its side effect: mongoose.model("User", schema)
// registers it on the shared connection so the populate("userId") call below
// can resolve the ref.
import "@/models/User";
import {
  getPendingDomainById,
  getPendingDomainByName,
  listActivePendingDomainsForUser,
  listAllPendingDomainNames,
} from "@/lib/services/pending-domains";

const validUserId = () => new mongoose.Types.ObjectId();

function buildPendingPayload(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  return {
    // PendingDomain's `_id` is `Schema.Types.Mixed required:true` to support
    // legacy string-typed ids; we have to set it explicitly.
    _id: new mongoose.Types.ObjectId(),
    domainName: `${tag}.test`,
    price: 800,
    currency: "INR",
    registrationPeriod: 1,
    userId: validUserId(),
    orderId: `ord_${tag}`,
    customerId: 12345,
    contactId: 67890,
    status: "pending",
    reason: "Awaiting registration",
    ...overrides,
  };
}

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  // Skip syncIndexes — PendingDomain's partial unique index uses $ne, which
  // mongodb-memory-server's standalone Mongo refuses to build. The tests
  // here don't depend on the unique-on-domainName index firing.
});

beforeEach(clearAllCollections);

describe("getPendingDomainById", () => {
  it("looks up a row by ObjectId _id", async () => {
    const created = await PendingDomain.create(
      buildPendingPayload({ domainName: "obj.test" })
    );
    const found = await getPendingDomainById(String(created._id));
    expect(found?.domainName).toBe("obj.test");
  });

  it("returns null when no match", async () => {
    expect(await getPendingDomainById("507f1f77bcf86cd799439011")).toBeNull();
  });

  it("populates userId when opts.populateUser is set", async () => {
    const userId = validUserId();
    // Insert a minimal User doc so populate has something to attach.
    await mongoose.connection.db?.collection("users").insertOne({
      _id: userId,
      email: "pop@user.test",
      firstName: "Pop",
      lastName: "User",
    });
    const created = await PendingDomain.create(
      buildPendingPayload({ userId, domainName: "pop.test" })
    );
    const populated = (await getPendingDomainById(String(created._id), {
      populateUser: true,
    })) as unknown as { userId: { email: string; firstName: string } };
    expect(populated.userId.email).toBe("pop@user.test");
  });
});

describe("getPendingDomainByName", () => {
  it("matches by domainName", async () => {
    await PendingDomain.create(buildPendingPayload({ domainName: "byname.test" }));
    expect((await getPendingDomainByName("byname.test"))?.domainName).toBe(
      "byname.test"
    );
  });
});

describe("listActivePendingDomainsForUser", () => {
  it("returns the user's non-archived rows newest first", async () => {
    const owner = validUserId();
    const other = validUserId();
    await PendingDomain.create(
      buildPendingPayload({ userId: owner, domainName: "owner-a.test" })
    );
    await new Promise((r) => setTimeout(r, 5));
    await PendingDomain.create(
      buildPendingPayload({ userId: owner, domainName: "owner-b.test" })
    );
    // Archived — should be hidden.
    await PendingDomain.create(
      buildPendingPayload({
        userId: owner,
        domainName: "archived.test",
        isArchived: true,
      })
    );
    // Other user — should be hidden.
    await PendingDomain.create(
      buildPendingPayload({ userId: other, domainName: "other.test" })
    );

    const list = await listActivePendingDomainsForUser(String(owner));
    expect(list.map((p) => p.domainName)).toEqual(["owner-b.test", "owner-a.test"]);
  });
});

describe("listAllPendingDomainNames", () => {
  it("returns every row projected to {domainName}", async () => {
    await PendingDomain.create(buildPendingPayload({ domainName: "one.test" }));
    await PendingDomain.create(buildPendingPayload({ domainName: "two.test" }));
    const list = await listAllPendingDomainNames();
    expect(list.map((p) => p.domainName).sort()).toEqual(["one.test", "two.test"]);
  });
});

describe("PendingDomain uniqueness scope (domainName, userId)", () => {
  // Two users failing to register the same name must produce two separate
  // PendingDomain audit rows. The partial unique index is scoped to
  // (domainName, userId) — if it were scoped to domainName alone, user B's
  // upsert would throw E11000 or silently overwrite user A's row + userId.
  it("allows two users to have a pending row for the same domain", async () => {
    const userA = validUserId();
    const userB = validUserId();
    const sameDomain = "contested.test";

    const rowA = await PendingDomain.create(
      buildPendingPayload({ domainName: sameDomain, userId: userA })
    );
    const rowB = await PendingDomain.create(
      buildPendingPayload({ domainName: sameDomain, userId: userB })
    );

    expect(String(rowA.userId)).toBe(String(userA));
    expect(String(rowB.userId)).toBe(String(userB));
    expect(String(rowA._id)).not.toBe(String(rowB._id));

    const list = await listAllPendingDomainNames();
    expect(list.filter((p) => p.domainName === sameDomain)).toHaveLength(2);
  });
});
