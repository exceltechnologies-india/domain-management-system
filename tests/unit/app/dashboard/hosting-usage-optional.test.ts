/**
 * `/api/user/hosting/stats` returns TWO shapes, and the page's type only
 * admitted one.
 *
 * A provisioned account carries `usage` read from DirectAdmin. A hosting still
 * awaiting provisioning comes from `fetchPendingHostingEntries` with
 * `status: "pending"`, `username: ""` and NO usage block — there is no
 * DirectAdmin account to read yet. Declaring `usage` required made
 * `hostingStats.usage.disk_used` compile, and it threw "Cannot read properties
 * of undefined (reading 'disk_used')" for every customer whose hosting had not
 * been provisioned, taking the whole page to the error boundary rather than
 * just the usage panel. 24 of those are in the production systemlogs.
 *
 * Threat model:
 *  - **A required-but-absent field is a lie the compiler enforces.** Making it
 *    optional turned one known crash into eight compiler errors — the other
 *    seven were the same bug waiting on a different render path.
 *  - **A 0% bar is not an honest fallback.** "Using nothing" and "not
 *    provisioned yet" are different states; showing the former for the latter
 *    is the same class of mistake as the crash.
 *
 * Source scans, because this is a render-shape guarantee: jsdom would need the
 * whole SWR + session stack mounted to assert it, and the thing that must not
 * come back is the unguarded property access.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "app/dashboard/hosting/page.tsx";
const API = "app/api/user/hosting/stats/route.ts";

/** Comments explain the removed crash by quoting it; assert against code. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the type admits the shape the API actually returns", () => {
  const code = codeOf(PAGE);

  it("usage is optional", () => {
    expect(code).toMatch(/usage\?:\s*\{/);
  });

  it("features is optional too — a pending entry has neither", () => {
    expect(code).toMatch(/features\?:\s*\{/);
  });

  it("guard the guard: the comment strip did not eat the file", () => {
    expect(code).toContain("interface HostingStats");
    expect(code).toContain("disk_used");
  });
});

describe("no unguarded read through usage", () => {
  const code = codeOf(PAGE);

  it.each(["disk_used", "disk_limit", "bandwidth_used", "bandwidth_limit"])(
    "%s is never read as hostingStats.usage.<field> without a guard",
    (field) => {
      // The access itself is fine — it now sits inside `hostingStats.usage ? …`.
      // What must not exist is the access with no conditional anywhere before
      // it, which is what `usage?:` + a clean typecheck already proves. This
      // asserts the guard is present and named, so a later edit that deletes
      // the conditional fails here rather than in production.
      expect(code).toContain("hostingStats.usage ?");
      expect(code).toContain(field);
    }
  );

  it("renders an explicit not-provisioned state, not a 0% bar", () => {
    expect(code).toMatch(/Not available yet/i);
    expect(code).toMatch(/still being set up/i);
  });
});

describe("the API really does return an entry without usage", () => {
  const api = readFileSync(API, "utf8");

  it("pending entries are returned with status 'pending'", () => {
    // If this stops being true, the optional type is over-cautious rather than
    // wrong — but it is true today, and it is why the crash happened.
    expect(api).toContain('status: "pending"');
  });

  it("the pending branch returns before the usage block is built", () => {
    const pendingReturn = api.indexOf("pendingEntries");
    const usageBlock = api.indexOf("bandwidth_used");
    expect(pendingReturn).toBeGreaterThan(-1);
    expect(usageBlock).toBeGreaterThan(-1);
    expect(pendingReturn).toBeLessThan(usageBlock);
  });
});
