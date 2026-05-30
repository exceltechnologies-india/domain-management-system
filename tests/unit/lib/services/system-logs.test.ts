/**
 * Tests for `@/lib/services/system-logs` (rescan-4 slice 7dg).
 * `recordSystemLog` writes browser-side error reports into the capped
 * SystemLog collection. Pins the default fields (level='error',
 * source='Unknown', user=null) and the explicit pass-through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const systemLogCreateMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/SystemLog", () => ({
  default: { create: systemLogCreateMock },
}));

import { recordSystemLog } from "@/lib/services/system-logs";

beforeEach(() => {
  connectDBMock.mockReset();
  systemLogCreateMock.mockReset();
});

describe("recordSystemLog", () => {
  it("connects to DB then calls SystemLog.create with the user-supplied + default fields", async () => {
    systemLogCreateMock.mockResolvedValueOnce({ _id: "log-1" });
    const result = await recordSystemLog({
      message: "boom",
      stack: "Error at line 10",
      service: "frontend",
      statusCode: 500,
    });
    expect(connectDBMock).toHaveBeenCalled();
    expect(systemLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        // Defaults
        level: "error",
        source: "Unknown",
        user: null,
        // Explicit pass-through
        message: "boom",
        stack: "Error at line 10",
        service: "frontend",
        statusCode: 500,
      })
    );
    expect(result).toMatchObject({ _id: "log-1" });
  });

  it("user-supplied level/source/user override the defaults", async () => {
    systemLogCreateMock.mockResolvedValueOnce({ _id: "log-2" });
    await recordSystemLog({
      level: "warn",
      message: "slow request",
      source: "frontend.middleware",
      user: "user-abc",
    });
    expect(systemLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "frontend.middleware",
        user: "user-abc",
      })
    );
  });

  it("optional fields are passed through verbatim (or undefined when absent)", async () => {
    systemLogCreateMock.mockResolvedValueOnce({ _id: "log-3" });
    await recordSystemLog({
      message: "minimal",
    });
    const arg = systemLogCreateMock.mock.calls[0][0];
    expect(arg.url).toBeUndefined();
    expect(arg.stack).toBeUndefined();
    expect(arg.metadata).toBeUndefined();
    expect(arg.requestId).toBeUndefined();
    expect(arg.statusCode).toBeUndefined();
    expect(arg.ip).toBeUndefined();
  });
});
