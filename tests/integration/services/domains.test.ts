/**
 * Service-layer integration tests for lib/services/domains.ts.
 *
 * The service is intentionally tiny (the bespoke Domain access patterns
 * stay in their callsites); these tests cover the two reused helpers.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import Domain from "@/models/Domain";
import { getDomainById, listDomainsForUser } from "@/lib/services/domains";

const validUserId = () => new mongoose.Types.ObjectId();

function buildDomainPayload(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  return {
    domainName: `${tag}.test`,
    status: "registered",
    dnsProvider: "resellerclub",
    price: 100,
    currency: "INR",
    registrationPeriod: 1,
    userId: validUserId(),
    ...overrides,
  };
}

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await Domain.syncIndexes();
});

beforeEach(clearAllCollections);

describe("listDomainsForUser", () => {
  it("returns newest-first and scopes by userId", async () => {
    const owner = validUserId();
    const other = validUserId();
    const a = await Domain.create(buildDomainPayload({ userId: owner, domainName: "a.test" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await Domain.create(buildDomainPayload({ userId: owner, domainName: "b.test" }));
    await Domain.create(buildDomainPayload({ userId: other, domainName: "c.test" }));

    const mine = await listDomainsForUser(String(owner));
    expect(mine.map((d) => d._id.toString())).toEqual([
      b._id.toString(),
      a._id.toString(),
    ]);
  });
});

describe("getDomainById", () => {
  it("returns the matching document or null when missing", async () => {
    const d = await Domain.create(buildDomainPayload({ domainName: "lookup.test" }));
    expect((await getDomainById(String(d._id)))?.domainName).toBe("lookup.test");
    expect(await getDomainById("507f1f77bcf86cd799439011")).toBeNull();
  });
});
