/**
 * Tests for `@/lib/integrations/directadmin` barrel (rescan-4 slice 7de).
 * Pins the export contract for the DirectAdmin anti-corruption layer
 * (M1 slice 2). A future rename of any underlying module surfaces here.
 */
import { describe, it, expect } from "vitest";
import * as barrel from "@/lib/integrations/directadmin";

describe("DirectAdmin barrel", () => {
  it("re-exports the 6 operation functions", () => {
    expect(typeof barrel.createUser).toBe("function");
    expect(typeof barrel.suspendUser).toBe("function");
    expect(typeof barrel.unsuspendUser).toBe("function");
    expect(typeof barrel.getUserConfig).toBe("function");
    expect(typeof barrel.deleteUser).toBe("function");
    expect(typeof barrel.changePackage).toBe("function");
  });

  it("re-exports the 6 classify* error helpers", () => {
    expect(typeof barrel.classifyCreateUserError).toBe("function");
    expect(typeof barrel.classifySuspendUserError).toBe("function");
    expect(typeof barrel.classifyUnsuspendUserError).toBe("function");
    expect(typeof barrel.classifyGetUserConfigError).toBe("function");
    expect(typeof barrel.classifyDeleteUserError).toBe("function");
    expect(typeof barrel.classifyChangePackageError).toBe("function");
  });

  it("re-exports the matchesAny helper + the 3 fragment-keyword lists", () => {
    expect(typeof barrel.matchesAny).toBe("function");
    expect(Array.isArray(barrel.USERNAME_COLLISION_FRAGMENTS)).toBe(true);
    expect(Array.isArray(barrel.USER_NOT_FOUND_FRAGMENTS)).toBe(true);
    expect(Array.isArray(barrel.PACKAGE_NOT_FOUND_FRAGMENTS)).toBe(true);
  });

  it("matchesAny works as a lower-case substring matcher (shared with ResellerClub)", () => {
    expect(
      barrel.matchesAny("User 'foo' already exists in DirectAdmin", barrel.USERNAME_COLLISION_FRAGMENTS)
    ).toBe(true);
    expect(barrel.matchesAny("plain message", barrel.USERNAME_COLLISION_FRAGMENTS)).toBe(false);
  });
});
