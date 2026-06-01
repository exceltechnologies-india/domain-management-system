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
vi.mock("@/models/PendingDomain", () => ({
  default: { findOne: findOneMock, find: findMock },
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
});

describe("getPendingDomainById", () => {
  it("ObjectId-valid id → $or with BOTH raw-string and ObjectId forms", async () => {
    const validHex = "507f1f77bcf86cd799439011";
    findOneMock.mockResolvedValueOnce({ _id: validHex, domainName: "example.com" });
    await getPendingDomainById(validHex);
    expect(connectDBMock).toHaveBeenCalled();
    const arg = findOneMock.mock.calls[0][0];
    expect(arg).toEqual({
      $or: [
        { _id: validHex },
        { _id: expect.any(mongoose.Types.ObjectId) },
      ],
    });
    // Confirm the ObjectId equals the hex.
    expect(String(arg.$or[1]._id)).toBe(validHex);
  });

  it("non-ObjectId-valid id (legacy string) → only the raw-string match", async () => {
    findOneMock.mockResolvedValueOnce(null);
    await getPendingDomainById("legacy-string-id");
    expect(findOneMock).toHaveBeenCalledWith({
      $or: [{ _id: "legacy-string-id" }],
    });
  });

  it("populateUser=true populates 'userId' with the admin projection", async () => {
    const populateMock = vi.fn().mockResolvedValue({ _id: "x" });
    findOneMock.mockReturnValue({ populate: populateMock });
    await getPendingDomainById("legacy", { populateUser: true });
    expect(populateMock).toHaveBeenCalledWith(
      "userId",
      "firstName lastName email phone companyName"
    );
  });

  it("populateUser=false (default) does NOT call populate", async () => {
    findOneMock.mockResolvedValueOnce(null);
    await getPendingDomainById("legacy");
    // findOne result is awaited directly (no .populate chain).
    expect(findOneMock).toHaveBeenCalled();
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
