/**
 * Tests for `@/lib/services/pending-domains` (rescan-4 slice 7dt).
 * Pins:
 *  - getPendingDomainById: tries both raw-string `_id` and ObjectId form
 *    in an $or query (defensive — legacy rows have string _id)
 *  - populateUser=true populates the owning User with the admin projection
 *  - getPendingDomainByName delegates to findOne({domainName})
 *  - listActivePendingDomainsForUser filters isArchived !== true + sorts
 *    newest-first
 *  - listAllPendingDomainNames returns lean projection of just `domainName`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const findOneMock = vi.hoisted(() => vi.fn());
const findMock = vi.hoisted(() => vi.fn());
const findByIdMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/PendingDomain", () => ({
  default: { findOne: findOneMock, find: findMock, findById: findByIdMock },
}));

import {
  getPendingDomainById,
  getPendingDomainByName,
  listActivePendingDomainsForUser,
  listAllPendingDomainNames,
} from "@/lib/services/pending-domains";

beforeEach(() => {
  connectDBMock.mockReset();
  findOneMock.mockReset();
  findMock.mockReset();
  findByIdMock.mockReset();
});

// getPendingDomainById was tightened in dms-00452 alongside the PendingDomain
// `_id` Mixed→ObjectId schema change: persisted rows always have an ObjectId
// _id, so it now does a plain `findById` for valid ObjectIds and returns null
// for anything else (e.g. the synthetic `order_<id>_<domain>` admin-list ids)
// instead of the old raw-string `$or` dual-query.
describe("getPendingDomainById", () => {
  const validHex = "507f1f77bcf86cd799439011";

  it("ObjectId-valid id → findById(id)", async () => {
    findByIdMock.mockResolvedValueOnce({ _id: validHex, domainName: "example.com" });
    await getPendingDomainById(validHex);
    expect(connectDBMock).toHaveBeenCalled();
    expect(findByIdMock).toHaveBeenCalledWith(validHex);
  });

  it("non-ObjectId id (synthetic/legacy string) → returns null, no query issued", async () => {
    const result = await getPendingDomainById("order_abc_example.com");
    expect(result).toBeNull();
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it("populateUser=true populates 'userId' with the admin projection", async () => {
    const populateMock = vi.fn().mockResolvedValue({ _id: "x" });
    findByIdMock.mockReturnValue({ populate: populateMock });
    await getPendingDomainById(validHex, { populateUser: true });
    expect(findByIdMock).toHaveBeenCalledWith(validHex);
    expect(populateMock).toHaveBeenCalledWith(
      "userId",
      "firstName lastName email phone companyName"
    );
  });

  it("populateUser=false (default) does NOT call populate", async () => {
    findByIdMock.mockResolvedValueOnce(null);
    await getPendingDomainById(validHex);
    expect(findByIdMock).toHaveBeenCalledWith(validHex);
  });
});

describe("getPendingDomainByName", () => {
  it("delegates to PendingDomain.findOne({domainName})", async () => {
    findOneMock.mockResolvedValueOnce({ _id: "x", domainName: "example.com" });
    const doc = await getPendingDomainByName("example.com");
    expect(connectDBMock).toHaveBeenCalled();
    expect(findOneMock).toHaveBeenCalledWith({ domainName: "example.com" });
    expect(doc).toMatchObject({ _id: "x" });
  });
});

describe("listActivePendingDomainsForUser", () => {
  it("filters isArchived !== true + sorts createdAt desc", async () => {
    const sortMock = vi.fn().mockResolvedValue([{ _id: "1" }]);
    findMock.mockReturnValue({ sort: sortMock });
    const docs = await listActivePendingDomainsForUser("user-1");
    expect(findMock).toHaveBeenCalledWith({
      userId: "user-1",
      isArchived: { $ne: true },
    });
    expect(sortMock).toHaveBeenCalledWith({ createdAt: -1 });
    expect(docs).toEqual([{ _id: "1" }]);
  });
});

describe("listAllPendingDomainNames", () => {
  it("returns lean projection of {domainName} only", async () => {
    findMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { domainName: "a.com" },
        { domainName: "b.com" },
      ]),
    });
    const names = await listAllPendingDomainNames();
    expect(findMock).toHaveBeenCalledWith({}, { domainName: 1 });
    expect(names).toEqual([{ domainName: "a.com" }, { domainName: "b.com" }]);
  });
});
