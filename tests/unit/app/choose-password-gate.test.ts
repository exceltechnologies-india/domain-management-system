/**
 * First sign-in with the one-time password: the portal asks for the customer's own password
 * before anything else (7 Oct 2026). Pins the gate end to end in source: the flag on the
 * account, in the token and session, the middleware redirect, the route that clears it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const read = (f: string) => readFileSync(f, "utf8");

describe("the choose-password gate", () => {
  it("the account carries mustChangePassword (default false)", () => {
    expect(read("models/User.ts")).toMatch(/mustChangePassword: \{\s*type: Boolean,\s*default: false,/);
  });
  it("login and every refresh put it on the token, and the session shows it", () => {
    const cb = read("lib/auth-config/callbacks.ts");
    expect(cb.match(/token\.mustChangePassword = dbUser\.mustChangePassword === true;/g)?.length).toBe(2);
    expect(cb).toContain("session.user.mustChangePassword = token.mustChangePassword === true;");
  });
  it("the middleware sends dashboard/checkout to /choose-password while it is set", () => {
    const mw = read("middleware.ts");
    expect(mw).toMatch(/if \(token\.mustChangePassword === true\) \{\s*const choose = new URL\("\/choose-password"/);
  });
  it("the route only works while the flag is set, checks strength, and clears it", () => {
    const r = read("app/api/user/choose-password/route.ts");
    expect(r).toContain("withPassword.mustChangePassword !== true");
    expect(r).toContain("validatePasswordStrength(newPassword)");
    expect(r).toContain("withPassword.mustChangePassword = false;");
  });
  it("the page refreshes the session before going on, so the gate lifts at once", () => {
    const p = read("app/choose-password/page.tsx");
    expect(p).toMatch(/await update\(\);[\s\S]*router\.replace\(safeReturn/);
  });
});
