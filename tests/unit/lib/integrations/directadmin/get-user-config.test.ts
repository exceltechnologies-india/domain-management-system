/**
 * Tests for `@/lib/integrations/directadmin/get-user-config` (rescan-4
 * slice 7di). Read wrapper — splits transient (retry) vs terminal
 * (orphaned hosting row) failures via the kind union.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const daGetConfigMock = vi.hoisted(() => vi.fn());
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
  DirectAdminService: { getUserConfig: daGetConfigMock },
  DirectAdminError: DirectAdminErrorMock,
}));

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: loggerWarn, error: loggerError, info: vi.fn() },
}));

import { getUserConfig } from "@/lib/integrations/directadmin/get-user-config";

beforeEach(() => {
  daGetConfigMock.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("getUserConfig wrapper", () => {
  it("happy path → {kind:'found', config}", async () => {
    daGetConfigMock.mockResolvedValueOnce({
      username: "u1",
      package: "basic",
      suspended: "no",
    });
    const result = await getUserConfig({ username: "u1" });
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.config).toMatchObject({ username: "u1", package: "basic" });
    }
  });

  it("user-not-found → kind:'user_not_found' + warn log (terminal — caller marks orphaned)", async () => {
    daGetConfigMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("User not found", 404)
    );
    const result = await getUserConfig({ username: "u1" });
    expect(result.kind).toBe("user_not_found");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("DA status=503 → kind:'da_unreachable' + warn log (caller retries)", async () => {
    daGetConfigMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("backend unavailable", 503)
    );
    const result = await getUserConfig({ username: "u1" });
    expect(result.kind).toBe("da_unreachable");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("generic Error → kind:'hard_failure' + error log", async () => {
    daGetConfigMock.mockRejectedValueOnce(new Error("permission denied"));
    const result = await getUserConfig({ username: "u1" });
    expect(result.kind).toBe("hard_failure");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
