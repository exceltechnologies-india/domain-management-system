/**
 * Tests for `@/lib/directadmin` barrel (rescan-4 slice 7dw).
 * Backwards-compat class shim that re-exports ~25 static methods from
 * the per-topic submodules (packages / users / dns / server) plus the
 * client-level constants + validators.
 */
import { describe, it, expect } from "vitest";
import { DirectAdminService, DirectAdminError, DA_SERVER_IP } from "@/lib/directadmin";

describe("DirectAdminService class shim", () => {
  it("exposes class-level constants from the client module", () => {
    expect(DirectAdminService.NAMESERVERS).toBeDefined();
    expect(DirectAdminService.KNOWN_PACKAGES).toBeDefined();
  });

  it("re-exports DirectAdminError class + DA_SERVER_IP constant", () => {
    expect(typeof DirectAdminError).toBe("function");
    expect(typeof DA_SERVER_IP).toBe("string");
  });

  it.each([
    // validators
    "validateUsername",
    "normalizePackageName",
    "validatePackageName",
    "logDebugCredentials",
    // users (12)
    "getOneTimeLoginUrl",
    "createUser",
    "getUserConfig",
    "getUserUsage",
    "getUserDomains",
    "changePackage",
    "suspendUser",
    "unsuspendUser",
    "deleteUser",
    "domainExists",
    "listUsers",
    "getAllUserUsage",
    // packages (3)
    "listPackages",
    "getPackageDetails",
    "createPackage",
    // dns (4)
    "getDNSRecords",
    "deleteDNSRecords",
    "addDNSRecord",
    "updateDNSNameservers",
    // server (3)
    "getServerInfo",
    "listResellers",
    "getLicenseInfo",
  ])("exposes %s as a static method", (name) => {
    expect(
      typeof (DirectAdminService as unknown as Record<string, unknown>)[name]
    ).toBe("function");
  });

  it("re-exports each submodule's same function reference (no per-call wrapper)", async () => {
    const users = await import("@/lib/directadmin/users");
    const server = await import("@/lib/directadmin/server");
    expect(DirectAdminService.createUser).toBe(users.createUser);
    expect(DirectAdminService.getServerInfo).toBe(server.getServerInfo);
  });
});
