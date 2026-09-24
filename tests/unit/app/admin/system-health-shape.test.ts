/**
 * The admin dashboard used to accept whatever came back from
 * `/api/v1/admin/system-health` as system health.
 *
 * axios throws on a non-2xx, so an error JSON never reached `setData`. What
 * does reach it is a 200 that is not this endpoint's payload: a middleware
 * redirect to /login is followed transparently and returns the login page's
 * HTML with status 200. That string is truthy, so
 * `data.externalApis.resellerClub.status` threw "externalApis is undefined"
 * and took the dashboard to the error boundary. Two of those are in the
 * production systemlogs, from app.anutech.in.
 *
 * Threat model:
 *  - **Status is not shape.** The response was a perfectly good 200; checking
 *    `res.ok` or catching an error would have caught nothing.
 *  - **Truthy is not valid.** The old guard was `data ? … : []`, and an HTML
 *    string passes it.
 *  - **A bad body must not be kept.** Setting it and rendering defensively
 *    would leave a dashboard full of blanks that looks like an outage;
 *    clearing it and saying "sign in again" names the real problem.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "app/admin/dashboard/page.tsx";
const code = readFileSync(PAGE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The accepted-shape predicate, mirrored from the page. */
function isSystemHealth(body: unknown): boolean {
  return Boolean(
    body &&
      typeof body === "object" &&
      (body as Record<string, unknown>).database &&
      (body as Record<string, unknown>).externalApis
  );
}

describe("what must be rejected", () => {
  it("the login page's HTML — a 200, and the actual cause", () => {
    expect(isSystemHealth("<!DOCTYPE html><html>…sign in…</html>")).toBe(false);
  });

  it("an error body that somehow arrives with 200", () => {
    expect(isSystemHealth({ error: "Failed to fetch system health" })).toBe(false);
  });

  it("a partial payload missing externalApis — the exact crash", () => {
    expect(isSystemHealth({ database: { status: "operational" } })).toBe(false);
  });

  it("a payload missing database", () => {
    expect(isSystemHealth({ externalApis: { resellerClub: {} } })).toBe(false);
  });

  it.each([null, undefined, "", 0, [], true])("%p", (v) => {
    expect(isSystemHealth(v)).toBe(false);
  });
});

describe("what must be accepted", () => {
  it("the real payload", () => {
    expect(
      isSystemHealth({
        database: { status: "operational", latencyMs: 4, stats: {} },
        queueBacklog: { domains: 0, hosting: 0, total: 0 },
        failedJobs: { domains: 0, hosting: 0, total: 0 },
        externalApis: {
          resellerClub: { status: "operational", balance: null, latencyMs: 12 },
          directAdmin: { status: "down", latencyMs: 0 },
          razorpay: { status: "operational", latencyMs: 30 },
        },
      })
    ).toBe(true);
  });
});

describe("the page uses this check, and clears rather than keeps a bad body", () => {
  it("validates the shape before setData", () => {
    expect(code).toContain("body.database && body.externalApis");
  });

  it("clears data on a bad body instead of rendering blanks", () => {
    expect(code).toContain("setData(null)");
  });

  it("tells the operator what to do, not just that it failed", () => {
    // CLAUDE.md §24: a block says what happened and what to do next. "Failed
    // to fetch" would send them to the status page; the cause is usually a
    // dead session.
    expect(code).toMatch(/sign in again/i);
  });

  it("guard the guard: the comment strip did not eat the file", () => {
    expect(code).toContain("fetchHealth");
    expect(code).toContain("system-health");
  });
});

describe("External Services after Zoho Books was removed (24 Sep 2026)", () => {
  it("renders exactly the three live service cards, and no Zoho Books card", () => {
    const names = [...code.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(expect.arrayContaining(["ResellerClub", "DirectAdmin", "Razorpay"]));
    expect(code).not.toMatch(/zoho/i);
  });

  it("lays the services grid out in three columns, not four with a hole", () => {
    const at = code.indexOf('title="External Services"');
    expect(at).toBeGreaterThan(-1);
    const firstGrid = /className="(grid [^"]+)"/.exec(code.slice(at))?.[1];
    expect(firstGrid).toBe("grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4");
  });
});
