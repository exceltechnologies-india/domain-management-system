/**
 * Tests for `@/lib/integrations/directadmin/unsuspend-user` (rescan-4
 * slice 7dh). Mirror of suspend-user but with renewal-flow semantics —
 * user_not_found is logged at ERROR (not warn) because the renewal
 * already took payment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const daUnsuspendMock = vi.hoisted(() => vi.fn());
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
  DirectAdminService: { unsuspendUser: daUnsuspendMock },
  DirectAdminError: DirectAdminErrorMock,
}));

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: loggerWarn, error: loggerError, info: vi.fn() },
}));

import { unsuspendUser } from "@/lib/integrations/directadmin/unsuspend-user";

beforeEach(() => {
  daUnsuspendMock.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("unsuspendUser wrapper", () => {
  it("happy path → DA call succeeds → {kind:'unsuspended'}", async () => {
    daUnsuspendMock.mockResolvedValueOnce(undefined);
    const result = await unsuspendUser({ username: "u1" });
    expect(result).toEqual({ kind: "unsuspended" });
    expect(daUnsuspendMock).toHaveBeenCalledWith("u1");
  });

  it("DirectAdminError matching USER_NOT_FOUND_FRAGMENTS → kind:'user_not_found' + ERROR-level log (renewal already paid)", async () => {
    daUnsuspendMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("User not found", 404)
    );
    const result = await unsuspendUser({ username: "u1" });
    expect(result.kind).toBe("user_not_found");
    // Unlike suspendUser (which logs at warn), unsuspendUser uses error
    // because we already collected money.
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatch(/renewal collected payment/);
  });

  it("DirectAdminError 503 → kind:'da_unreachable' + warn log", async () => {
    daUnsuspendMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("backend unavailable", 503)
    );
    const result = await unsuspendUser({ username: "u1" });
    expect(result.kind).toBe("da_unreachable");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("Generic Error → kind:'hard_failure' + error log", async () => {
    daUnsuspendMock.mockRejectedValueOnce(new Error("permission denied"));
    const result = await unsuspendUser({ username: "u1" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalled();
  });
});
