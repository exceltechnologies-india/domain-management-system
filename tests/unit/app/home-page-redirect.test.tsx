/**
 * `app/page.tsx` — DMS's homepage, and whether it serves one at all.
 *
 * When ResellerOS is the front door DMS must not present a second, competing
 * marketing site: `/` redirects there instead.
 *
 * Threat model:
 *  - **Switching off a working homepage by accident.** An unset variable must
 *    leave DMS standalone and rendering its own landing. A default of
 *    "delegated" would have blanked the homepage of every DMS deployment the
 *    moment this merged. Pinned in both directions.
 *  - **Paying for a page nobody sees.** The redirect must happen BEFORE the
 *    plan/appearance reads, which hit Mongo and Redis. Pinned by asserting
 *    those services are never called on the redirect path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    // The real next/navigation redirect() throws to unwind the render.
    // Mimicking that is what proves nothing below it runs.
    const e = new Error(`NEXT_REDIRECT:${url}`);
    throw e;
  })
);
vi.mock("next/navigation", () => ({ redirect }));

const listActivePlans = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ listActivePlans }));

const getHomeVariant = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/appearance", () => ({ getHomeVariant }));

vi.mock("@/components/marketing/HostingLanding", () => ({
  default: () => null,
}));
vi.mock("@/components/marketing/DomainHome", () => ({ default: () => null }));

import HomePage from "@/app/page";

const ORIGINAL = process.env.NEXT_PUBLIC_RESELLEROS_URL;

beforeEach(() => {
  redirect.mockClear();
  listActivePlans.mockReset().mockResolvedValue([]);
  getHomeVariant.mockReset().mockResolvedValue("landing");
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_RESELLEROS_URL;
  else process.env.NEXT_PUBLIC_RESELLEROS_URL = ORIGINAL;
});

describe("ResellerOS configured — DMS serves no homepage", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_RESELLEROS_URL = "https://app.example.com";
  });

  it("redirects to ResellerOS", async () => {
    await expect(HomePage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirect).toHaveBeenCalledWith("https://app.example.com");
  });

  it("does not read plans or appearance first", async () => {
    await expect(HomePage()).rejects.toThrow();
    expect(listActivePlans).not.toHaveBeenCalled();
    expect(getHomeVariant).not.toHaveBeenCalled();
  });

  it("strips a trailing slash rather than emitting a double one", async () => {
    process.env.NEXT_PUBLIC_RESELLEROS_URL = "https://app.example.com/";
    await expect(HomePage()).rejects.toThrow();
    expect(redirect).toHaveBeenCalledWith("https://app.example.com");
  });
});

describe("ResellerOS not configured — DMS is unchanged", () => {
  it("unset → renders its own homepage, no redirect", async () => {
    delete process.env.NEXT_PUBLIC_RESELLEROS_URL;
    await expect(HomePage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
    // And it still does the work the homepage needs.
    expect(getHomeVariant).toHaveBeenCalled();
  });

  it("a value with no scheme is refused, not turned into a broken redirect", async () => {
    // "app.example.com" in an href resolves against the current path. A
    // redirect to it would be worse than no redirect.
    process.env.NEXT_PUBLIC_RESELLEROS_URL = "app.example.com";
    await expect(HomePage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("empty → renders, never redirects to \"\"", async () => {
    process.env.NEXT_PUBLIC_RESELLEROS_URL = "";
    await expect(HomePage()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});
