/**
 * Unit tests for the DirectAdmin anti-corruption layer classifier
 * (rescan-4 M1 slice 2). Pins the username-collision / unreachable /
 * hard-failure discrimination so a DA wording tweak can't silently
 * misroute a "503 backend down" into "hard failure" and skip the
 * pending-hosting cron retry.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCreateUserError,
  classifySuspendUserError,
} from "@/lib/integrations/directadmin/classify";

describe("classifyCreateUserError", () => {
  it("'already exists' message → collision (regardless of status)", () => {
    expect(classifyCreateUserError("User already exists", undefined)).toEqual({
      kind: "collision",
    });
    expect(classifyCreateUserError("Domain already exists on the server", 200)).toEqual({
      kind: "collision",
    });
  });

  it("case-insensitive match on 'already exists'", () => {
    expect(classifyCreateUserError("USER ALREADY EXISTS", undefined)).toEqual({
      kind: "collision",
    });
  });

  it("status 503 without collision message → unreachable", () => {
    const out = classifyCreateUserError("Backend timed out", 503);
    expect(out.kind).toBe("unreachable");
    if (out.kind === "unreachable") expect(out.reason).toBe("Backend timed out");
  });

  it("status 503 with no message → unreachable with default reason", () => {
    const out = classifyCreateUserError(undefined, 503);
    expect(out.kind).toBe("unreachable");
    if (out.kind === "unreachable") expect(out.reason).toMatch(/503/);
  });

  it("any other error → hard failure", () => {
    const out = classifyCreateUserError("Package not found", 200);
    expect(out.kind).toBe("hard");
    if (out.kind === "hard") expect(out.reason).toBe("Package not found");
  });

  it("undefined error message + undefined status → hard failure", () => {
    const out = classifyCreateUserError(undefined, undefined);
    expect(out.kind).toBe("hard");
    if (out.kind === "hard") expect(out.reason).toMatch(/createUser failed/);
  });

  it("collision takes precedence over 503 status (DA can return both)", () => {
    expect(classifyCreateUserError("user already exists", 503)).toEqual({
      kind: "collision",
    });
  });
});

describe("classifySuspendUserError", () => {
  it.each([
    "Unable to find user foo on the server",
    "No such user: foo",
    "User does not exist",
    "user not found",
    "Unknown user",
    "Cannot find user account",
  ])("recognises user_not_found fragment: %s", (msg) => {
    const out = classifySuspendUserError(msg, undefined);
    expect(out.kind).toBe("user_not_found");
  });

  it("user_not_found takes precedence over 503", () => {
    const out = classifySuspendUserError("user not found", 503);
    expect(out.kind).toBe("user_not_found");
  });

  it("status 503 without user_not_found → unreachable", () => {
    const out = classifySuspendUserError("backend timed out", 503);
    expect(out.kind).toBe("unreachable");
    if (out.kind === "unreachable") expect(out.reason).toBe("backend timed out");
  });

  it("anything else → hard", () => {
    const out = classifySuspendUserError("Permission denied", 200);
    expect(out.kind).toBe("hard");
    if (out.kind === "hard") expect(out.reason).toBe("Permission denied");
  });

  it("undefined message + undefined status → hard with default reason", () => {
    const out = classifySuspendUserError(undefined, undefined);
    expect(out.kind).toBe("hard");
    if (out.kind === "hard") expect(out.reason).toMatch(/suspendUser failed/);
  });
});
