/**
 * Tests for `@/lib/integrations/directadmin/delete-user` (rescan-4
 * slice 7di). Same wrapper shape as suspend/unsuspend, but the
 * user_not_found outcome is logged at INFO (not warn/error) because
 * cleanup callsites coalesce "already gone" with success.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const daDeleteMock = vi.hoisted(() => vi.fn());
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
  DirectAdminService: { deleteUser: daDeleteMock },
  DirectAdminError: DirectAdminErrorMock,
}));

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));

import { deleteUser } from "@/lib/integrations/directadmin/delete-user";

beforeEach(() => {
  daDeleteMock.mockReset();
  loggerInfo.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("deleteUser wrapper", () => {
  it("happy path → {kind:'deleted'} with no log", async () => {
    daDeleteMock.mockResolvedValueOnce(undefined);
    const result = await deleteUser({ username: "u1" });
    expect(result).toEqual({ kind: "deleted" });
    expect(daDeleteMock).toHaveBeenCalledWith("u1");
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("user-not-found → kind:'user_not_found' + INFO log ('already gone, treating as success')", async () => {
    daDeleteMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("User not found", 404)
    );
    const result = await deleteUser({ username: "u1" });
    expect(result.kind).toBe("user_not_found");
    // Cleanup intent — log at INFO, NOT warn/error.
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerInfo.mock.calls[0][0]).toMatch(/already gone/);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("DA status=503 → kind:'da_unreachable' + warn log", async () => {
    daDeleteMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("backend unavailable", 503)
    );
    const result = await deleteUser({ username: "u1" });
    expect(result.kind).toBe("da_unreachable");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("generic Error → kind:'hard_failure' + error log", async () => {
    daDeleteMock.mockRejectedValueOnce(new Error("permission denied"));
    const result = await deleteUser({ username: "u1" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
