/**
 * Tests for `@/lib/integrations/directadmin/create-user` (rescan-4 slice
 * 7dl). The username-collision retry loop — iterates a candidate list,
 * returns the first success, exhausts on all-collision, branches early
 * on non-collision errors. Pins:
 *  - Empty candidate list → hard_failure 'no username candidates'
 *  - First-candidate success → {kind:'created', username}
 *  - First collision + second success → tries the second candidate
 *  - All candidates collide → {kind:'username_collision_exhausted'}
 *  - Status=503 short-circuits → da_unreachable (no further candidates)
 *  - Generic Error short-circuits → hard_failure
 *  - Default `ip` falls back to DA_SERVER_IP from the SDK module
 *  - Custom `ip` overrides DA_SERVER_IP
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const daCreateUserMock = vi.hoisted(() => vi.fn());
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
  DirectAdminService: { createUser: daCreateUserMock },
  DirectAdminError: DirectAdminErrorMock,
  DA_SERVER_IP: "203.0.113.42",
}));

const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: loggerWarn, error: loggerError, info: vi.fn() },
}));

import { createUser } from "@/lib/integrations/directadmin/create-user";

const BASE: Omit<Parameters<typeof createUser>[0], "usernameCandidates"> & {
  usernameCandidates: string[];
} = {
  email: "u@example.test",
  domain: "example.com",
  packageName: "basic",
  usernameCandidates: ["alice", "alice1", "alice2"],
};

beforeEach(() => {
  daCreateUserMock.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe("createUser wrapper", () => {
  it("empty candidate list → {kind:'hard_failure', reason:'no username candidates provided'}", async () => {
    const result = await createUser({ ...BASE, usernameCandidates: [] });
    expect(result).toEqual({
      kind: "hard_failure",
      reason: "no username candidates provided",
    });
    expect(daCreateUserMock).not.toHaveBeenCalled();
  });

  it("first candidate succeeds → {kind:'created', username:'alice'} (no retries)", async () => {
    daCreateUserMock.mockResolvedValueOnce(undefined);
    const result = await createUser(BASE);
    expect(result).toEqual({ kind: "created", username: "alice" });
    expect(daCreateUserMock).toHaveBeenCalledTimes(1);
    expect(daCreateUserMock).toHaveBeenCalledWith(
      "alice",
      "u@example.test",
      "example.com",
      "basic",
      "203.0.113.42"
    );
  });

  it("first candidate collides → tries 'alice1' (success) + warn log on the retry", async () => {
    daCreateUserMock
      .mockRejectedValueOnce(new DirectAdminErrorMock("User already exists", 200))
      .mockResolvedValueOnce(undefined);
    const result = await createUser(BASE);
    expect(result).toEqual({ kind: "created", username: "alice1" });
    expect(daCreateUserMock).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0][0]).toMatch(/username collision on "alice"/);
  });

  it("all candidates collide → {kind:'username_collision_exhausted'} + final warn log", async () => {
    daCreateUserMock
      .mockRejectedValueOnce(new DirectAdminErrorMock("User already exists", 200))
      .mockRejectedValueOnce(new DirectAdminErrorMock("User already exists", 200))
      .mockRejectedValueOnce(new DirectAdminErrorMock("User already exists", 200));
    const result = await createUser(BASE);
    expect(result).toEqual({ kind: "username_collision_exhausted" });
    expect(daCreateUserMock).toHaveBeenCalledTimes(3);
    // 2 mid-loop warns + 1 final 'exhausted' warn = 3 total.
    expect(loggerWarn).toHaveBeenCalledTimes(3);
    expect(loggerWarn.mock.calls[2][0]).toMatch(/exhausted all 3 candidates/);
  });

  it("DA status=503 short-circuits → {kind:'da_unreachable'} (no further candidates tried)", async () => {
    daCreateUserMock.mockRejectedValueOnce(
      new DirectAdminErrorMock("backend unavailable", 503)
    );
    const result = await createUser(BASE);
    expect(result.kind).toBe("da_unreachable");
    expect(daCreateUserMock).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("Generic Error short-circuits → {kind:'hard_failure'} (no further candidates tried)", async () => {
    daCreateUserMock.mockRejectedValueOnce(new Error("permission denied"));
    const result = await createUser(BASE);
    expect(result.kind).toBe("hard_failure");
    expect(daCreateUserMock).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("default ip falls back to DA_SERVER_IP", async () => {
    daCreateUserMock.mockResolvedValueOnce(undefined);
    await createUser(BASE);
    // 5th arg is the ip — DA_SERVER_IP mocked to 203.0.113.42 above.
    expect(daCreateUserMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "203.0.113.42"
    );
  });

  it("custom ip overrides DA_SERVER_IP", async () => {
    daCreateUserMock.mockResolvedValueOnce(undefined);
    await createUser({ ...BASE, ip: "10.0.0.1" });
    expect(daCreateUserMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "10.0.0.1"
    );
  });
});
