/**
 * Tests for `@/lib/integrations/directadmin/change-package` (rescan-4
 * slice 7di). The hosting-upgrade flow's plumbing — adds a 5th kind
 * (`package_not_found`) on top of the other DA user-op outcomes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const daChangePackageMock = vi.hoisted(() => vi.fn());
const DirectAdminErrorMock = vi.hoisted(
  () =>
    class DirectAdminError extends Error {
      status?: number;
      constructor(message: string, status?: number) {
        super(message);
        this.name = "DirectAdminError";
        this.status = status;
      }
    }
);
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { changePackage: daChangePackageMock },
  DirectAdminError: DirectAdminErrorMock,
}));

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: loggerWarn, error: loggerError, info: vi.fn() },
}));

import { changePackage } from "@/lib/integrations/directadmin/change-package";

beforeEach(() => {
  daChangePackageMock.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("changePackage wrapper", () => {
  it("happy path → {kind:'changed'} + forwards both args (username + newPackage)", async () => {
    daChangePackageMock.mockResolvedValueOnce(undefined);
    const result = await changePackage({ username: "u1", newPackage: "biz-plus" });
    expect(result).toEqual({ kind: "changed" });
    expect(daChangePackageMock).toHaveBeenCalledWith("u1", "biz-plus");
  });

  it("user-not-found → kind:'user_not_found' + ERROR log (upgrade flow already paid)", async () => {
    daChangePackageMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("User not found", 404)
    );
    const result = await changePackage({ username: "u1", newPackage: "biz-plus" });
    expect(result.kind).toBe("user_not_found");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("package-not-found → kind:'package_not_found' + ERROR log (config/seeding error)", async () => {
    // 'Package does not exist' is in PACKAGE_NOT_FOUND_FRAGMENTS.
    daChangePackageMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("Package does not exist", 400)
    );
    const result = await changePackage({ username: "u1", newPackage: "biz-plus" });
    expect(result.kind).toBe("package_not_found");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatch(/biz-plus/);
  });

  it("DA status=503 → kind:'da_unreachable' + warn log", async () => {
    daChangePackageMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("backend unavailable", 503)
    );
    const result = await changePackage({ username: "u1", newPackage: "biz-plus" });
    expect(result.kind).toBe("da_unreachable");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("generic Error → kind:'hard_failure' + error log", async () => {
    daChangePackageMock.mockRejectedValueOnce(new Error("permission denied"));
    const result = await changePackage({ username: "u1", newPackage: "biz-plus" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalled();
  });
});
