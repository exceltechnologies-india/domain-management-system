/**
 * Tests for `@/lib/services/ip-checks` (rescan-4 slice 7dg).
 * Two helpers around the IPCheck collection — recordIPCheck (POST) +
 * getLatestIPCheck (GET, with checkedBy populated for the admin panel).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const ipCheckCreateMock = vi.hoisted(() => vi.fn());
const ipCheckFindOneMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/IPCheck", () => ({
  default: { create: ipCheckCreateMock, findOne: ipCheckFindOneMock },
}));

const userImportMock = vi.hoisted(() => ({ default: { modelName: "User" } }));
vi.mock("@/models/User", () => userImportMock);

import { recordIPCheck, getLatestIPCheck } from "@/lib/services/ip-checks";

beforeEach(() => {
  connectDBMock.mockReset();
  ipCheckCreateMock.mockReset();
  ipCheckFindOneMock.mockReset();
});

describe("recordIPCheck", () => {
  it("connects to DB then writes a fresh IPCheck row, stamping checkedAt server-side", async () => {
    ipCheckCreateMock.mockResolvedValueOnce({ _id: "ip-1" });
    const result = await recordIPCheck({
      success: true,
      message: "ip: 1.2.3.4",
      data: { ip: "1.2.3.4" } as never,
      checkedBy: "user-1",
    });
    expect(connectDBMock).toHaveBeenCalled();
    expect(ipCheckCreateMock).toHaveBeenCalledTimes(1);
    const arg = ipCheckCreateMock.mock.calls[0][0];
    expect(arg.success).toBe(true);
    expect(arg.message).toBe("ip: 1.2.3.4");
    expect(arg.data).toEqual({ ip: "1.2.3.4" });
    expect(arg.checkedBy).toBe("user-1");
    // checkedAt is stamped server-side (Date).
    expect(arg.checkedAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ _id: "ip-1" });
  });

  it("error case persists with error string + success=false", async () => {
    ipCheckCreateMock.mockResolvedValueOnce({ _id: "ip-2" });
    await recordIPCheck({
      success: false,
      message: "all 3 providers failed",
      error: "fetch failed",
      checkedBy: "user-1",
    });
    const arg = ipCheckCreateMock.mock.calls[0][0];
    expect(arg.success).toBe(false);
    expect(arg.error).toBe("fetch failed");
    expect(arg.data).toBeUndefined();
  });
});

describe("getLatestIPCheck", () => {
  it("returns the most-recent row with checkedBy populated, lazy-importing User", async () => {
    const populateStub = vi.fn().mockResolvedValue({ _id: "ip-2" });
    const sortStub = vi.fn().mockReturnValue({ populate: populateStub });
    ipCheckFindOneMock.mockReturnValue({ sort: sortStub });
    const result = await getLatestIPCheck();
    expect(connectDBMock).toHaveBeenCalled();
    expect(ipCheckFindOneMock).toHaveBeenCalledWith();
    expect(sortStub).toHaveBeenCalledWith({ checkedAt: -1 });
    // The 3rd arg to populate is the lazy-imported User model — pins that
    // the file doesn't accidentally drop the explicit model argument
    // (Mongoose's typed overload doesn't include it but the runtime needs it).
    expect(populateStub).toHaveBeenCalledWith(
      "checkedBy",
      "firstName lastName email",
      userImportMock.default
    );
    expect(result).toMatchObject({ _id: "ip-2" });
  });

  it("returns null when the collection is empty", async () => {
    ipCheckFindOneMock.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        populate: vi.fn().mockResolvedValue(null),
      }),
    });
    expect(await getLatestIPCheck()).toBeNull();
  });
});
