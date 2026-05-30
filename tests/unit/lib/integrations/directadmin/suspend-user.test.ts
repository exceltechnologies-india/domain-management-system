/**
 * Tests for `@/lib/integrations/directadmin/suspend-user` (rescan-4
 * slice 7dh). The wrapper maps thrown DirectAdminError / generic Error
 * onto the SuspendUserOutcome union so callers branch on `kind` instead
 * of guessing whether to retry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const daSuspendMock = vi.hoisted(() => vi.fn());
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
  DirectAdminService: { suspendUser: daSuspendMock },
  DirectAdminError: DirectAdminErrorMock,
}));

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: loggerWarn, error: loggerError, info: vi.fn() },
}));

import { suspendUser } from "@/lib/integrations/directadmin/suspend-user";

beforeEach(() => {
  daSuspendMock.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("suspendUser wrapper", () => {
  it("happy path → DA call succeeds → {kind:'suspended'} with no log", async () => {
    daSuspendMock.mockResolvedValueOnce(undefined);
    const result = await suspendUser({ username: "u123" });
    expect(result).toEqual({ kind: "suspended" });
    expect(daSuspendMock).toHaveBeenCalledWith("u123", undefined);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("forwards the reason arg when supplied", async () => {
    daSuspendMock.mockResolvedValueOnce(undefined);
    await suspendUser({ username: "u123", reason: "Refund" });
    expect(daSuspendMock).toHaveBeenCalledWith("u123", "Refund");
  });

  it("DirectAdminError matching USER_NOT_FOUND_FRAGMENTS → kind:'user_not_found' + warn log", async () => {
    // 'user not found' is in USER_NOT_FOUND_FRAGMENTS verbatim.
    daSuspendMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("User not found", 404)
    );
    const result = await suspendUser({ username: "u123" });
    expect(result.kind).toBe("user_not_found");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("DirectAdminError 503 → kind:'da_unreachable' + error log", async () => {
    // Only 503 maps to unreachable (matches DA's nginx-up-backend-down pattern).
    daSuspendMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("backend unavailable", 503)
    );
    const result = await suspendUser({ username: "u123" });
    expect(result.kind).toBe("da_unreachable");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("Generic Error → kind:'hard_failure' + error log", async () => {
    daSuspendMock.mockRejectedValueOnce(new Error("Permission denied"));
    const result = await suspendUser({ username: "u123" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
