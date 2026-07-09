/**
 * Tests for `@/lib/services/domains` (rescan-4 slice 7dg).
 * Two thin Domain-collection helpers — listDomainsForUser + getDomainById.
 * Mocks @/lib/mongodb (connectDB) + the Mongoose Domain model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const domainFindMock = vi.hoisted(() => vi.fn());
const domainFindByIdMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: { find: domainFindMock, findById: domainFindByIdMock },
}));

import { listDomainsForUser, getDomainById } from "@/lib/services/domains";

beforeEach(() => {
  connectDBMock.mockReset();
  domainFindMock.mockReset();
  domainFindByIdMock.mockReset();
});

describe("listDomainsForUser", () => {
  it("connects to DB then queries Domain.find({userId}).sort({createdAt:-1})", async () => {
    const sortStub = vi.fn().mockResolvedValue([{ _id: "d1" }]);
    domainFindMock.mockReturnValue({ sort: sortStub });
    const docs = await listDomainsForUser("user-123");
    expect(connectDBMock).toHaveBeenCalledTimes(1);
    // Must exclude soft-deleted domains (deletedAt: null matches active + missing).
    expect(domainFindMock).toHaveBeenCalledWith({ userId: "user-123", deletedAt: null });
    expect(sortStub).toHaveBeenCalledWith({ createdAt: -1 });
    expect(docs).toEqual([{ _id: "d1" }]);
  });

  it("returns empty array when the user has no domains", async () => {
    domainFindMock.mockReturnValue({ sort: vi.fn().mockResolvedValue([]) });
    expect(await listDomainsForUser("nobody")).toEqual([]);
  });
});

describe("getDomainById", () => {
  it("connects to DB then queries Domain.findById(id)", async () => {
    domainFindByIdMock.mockResolvedValueOnce({ _id: "d1", name: "example.com" });
    const doc = await getDomainById("d1");
    expect(connectDBMock).toHaveBeenCalled();
    expect(domainFindByIdMock).toHaveBeenCalledWith("d1");
    expect(doc).toMatchObject({ _id: "d1", name: "example.com" });
  });

  it("returns null when not found", async () => {
    domainFindByIdMock.mockResolvedValueOnce(null);
    expect(await getDomainById("missing")).toBeNull();
  });
});
