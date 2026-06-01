/**
 * Tests for `@/lib/integrations/directadmin/classify` (rescan-4 slice 7ef).
 * Pure DA-error → typed-outcome classifiers. Pins the **shared vocabulary**:
 *  - USERNAME_COLLISION_FRAGMENTS = ['already exists']
 *  - USER_NOT_FOUND_FRAGMENTS = 6 wordings (unable to find / no such /
 *    does not exist / not found / unknown / cannot find user)
 *  - PACKAGE_NOT_FOUND_FRAGMENTS = 6 wordings (does not exist / no such /
 *    not found / unable to find / cannot find / invalid)
 *  - matchesAny: case-insensitive substring; undefined/empty → false
 *  - All 6 classifiers (createUser / suspendUser / unsuspendUser /
 *    getUserConfig / deleteUser / changePackage) follow the **same
 *    priority order**: vocabulary-matched-kind → 503-unreachable →
 *    hard-failure with a stamped-default-reason naming the operation
 *  - changePackage uniquely has a 4th branch: USER_NOT_FOUND CHECKED
 *    FIRST, then PACKAGE_NOT_FOUND (the same response can contain both
 *    fragments when both username + package are wrong — user dominates)
 */
import { describe, it, expect } from "vitest";
import {
  USERNAME_COLLISION_FRAGMENTS,
  USER_NOT_FOUND_FRAGMENTS,
  PACKAGE_NOT_FOUND_FRAGMENTS,
  matchesAny,
  classifyCreateUserError,
  classifySuspendUserError,
  classifyUnsuspendUserError,
  classifyGetUserConfigError,
  classifyDeleteUserError,
  classifyChangePackageError,
} from "@/lib/integrations/directadmin/classify";

describe("vocabulary constants", () => {
  it("USERNAME_COLLISION_FRAGMENTS = ['already exists']", () => {
    expect(USERNAME_COLLISION_FRAGMENTS).toEqual(["already exists"]);
  });

  it("USER_NOT_FOUND_FRAGMENTS covers 6 DA wordings", () => {
    expect(USER_NOT_FOUND_FRAGMENTS).toEqual([
      "unable to find user",
      "no such user",
      "user does not exist",
      "user not found",
      "unknown user",
      "cannot find user",
    ]);
  });

  it("PACKAGE_NOT_FOUND_FRAGMENTS covers 6 DA wordings", () => {
    expect(PACKAGE_NOT_FOUND_FRAGMENTS).toEqual([
      "package does not exist",
      "no such package",
      "package not found",
      "unable to find the package",
      "cannot find package",
      "invalid package",
    ]);
  });
});

describe("matchesAny", () => {
  it("case-insensitive substring match", () => {
    expect(matchesAny("USER NOT Found at line 5", USER_NOT_FOUND_FRAGMENTS)).toBe(true);
  });

  it("undefined haystack → false (no throw)", () => {
    expect(matchesAny(undefined, USER_NOT_FOUND_FRAGMENTS)).toBe(false);
  });

  it("empty haystack → false", () => {
    expect(matchesAny("", USER_NOT_FOUND_FRAGMENTS)).toBe(false);
  });

  it("no fragment present → false", () => {
    expect(matchesAny("everything is fine", USER_NOT_FOUND_FRAGMENTS)).toBe(false);
  });
});

describe("classifyCreateUserError", () => {
  it("'already exists' anywhere → collision", () => {
    expect(classifyCreateUserError("User pawan42 already exists", 200))
      .toEqual({ kind: "collision" });
  });

  it("daStatus 503 with no collision-fragment → unreachable", () => {
    expect(classifyCreateUserError("Service Unavailable", 503))
      .toEqual({ kind: "unreachable", reason: "Service Unavailable" });
  });

  it("missing reason on 503 → stamped default 'DA returned 503'", () => {
    expect(classifyCreateUserError(undefined, 503))
      .toEqual({ kind: "unreachable", reason: "DA returned 503" });
  });

  it("anything else → hard with stamped default reason", () => {
    expect(classifyCreateUserError(undefined, 200))
      .toEqual({ kind: "hard", reason: "DA createUser failed" });
  });
});

describe("classifySuspendUserError + classifyUnsuspendUserError + classifyGetUserConfigError + classifyDeleteUserError", () => {
  const ops = [
    { name: "suspendUser", fn: classifySuspendUserError, default: "DA suspendUser failed" },
    { name: "unsuspendUser", fn: classifyUnsuspendUserError, default: "DA unsuspendUser failed" },
    { name: "getUserConfig", fn: classifyGetUserConfigError, default: "DA getUserConfig failed" },
    { name: "deleteUser", fn: classifyDeleteUserError, default: "DA deleteUser failed" },
  ];

  it.each(ops)("$name: user-not-found wordings → user_not_found", ({ fn }) => {
    expect(fn("User does not exist", 200)).toMatchObject({ kind: "user_not_found" });
    expect(fn("Unknown user", 200)).toMatchObject({ kind: "user_not_found" });
    expect(fn("Unable to find user pawan42", 200)).toMatchObject({
      kind: "user_not_found",
    });
  });

  it.each(ops)("$name: 503 → unreachable", ({ fn }) => {
    expect(fn("backend down", 503)).toEqual({
      kind: "unreachable",
      reason: "backend down",
    });
  });

  it.each(ops)("$name: hard with op-specific default reason", ({ fn, default: dflt }) => {
    expect(fn(undefined, 200)).toEqual({ kind: "hard", reason: dflt });
  });
});

describe("classifyChangePackageError", () => {
  it("USER_NOT_FOUND checked FIRST (dominates package-not-found in mixed responses)", () => {
    // DA sometimes emits both fragments when both fields are wrong.
    expect(
      classifyChangePackageError(
        "User does not exist; package not found",
        200
      )
    ).toMatchObject({ kind: "user_not_found" });
  });

  it("package-not-found wording → package_not_found", () => {
    expect(classifyChangePackageError("Invalid package", 200))
      .toMatchObject({ kind: "package_not_found" });
    expect(classifyChangePackageError("Package does not exist", 200))
      .toMatchObject({ kind: "package_not_found" });
    expect(classifyChangePackageError("Cannot find package basic-shared", 200))
      .toMatchObject({ kind: "package_not_found" });
  });

  it("503 with no matched-vocabulary → unreachable", () => {
    expect(classifyChangePackageError("network down", 503))
      .toEqual({ kind: "unreachable", reason: "network down" });
  });

  it("anything else → hard with stamped default 'DA changePackage failed'", () => {
    expect(classifyChangePackageError(undefined, 200))
      .toEqual({ kind: "hard", reason: "DA changePackage failed" });
  });
});
