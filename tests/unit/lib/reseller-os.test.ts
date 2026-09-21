/**
 * Tests for `lib/reseller-os.ts` — the one switch that decides whether
 * ResellerOS is DMS's front door.
 *
 * Threat model:
 *  - **A relative link is not a degraded link, it is a wrong one.** If an
 *    unset or malformed value resolved to `""`, every brand link would
 *    become a same-origin path and quietly point back at DMS. Pinned:
 *    `resellerOsUrl()` returns null, never "".
 *  - **Turning the frontpage off must be a decision, not a side effect.**
 *    An unset variable keeps DMS standalone. Pinned, because the tempting
 *    design — default to delegated — would have switched off a working
 *    homepage for every DMS deployment the moment this merged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resellerOsUrl, homeUrl, frontpageIsDelegated } from "@/lib/reseller-os";

const ORIGINAL = process.env.NEXT_PUBLIC_RESELLEROS_URL;

function set(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_RESELLEROS_URL;
  else process.env.NEXT_PUBLIC_RESELLEROS_URL = value;
}

beforeEach(() => set(undefined));
afterEach(() => set(ORIGINAL));

describe("resellerOsUrl — configured", () => {
  it("returns the origin", () => {
    set("https://app.example.com");
    expect(resellerOsUrl()).toBe("https://app.example.com");
  });

  it("strips trailing slashes so callers can concatenate", () => {
    set("https://app.example.com///");
    expect(resellerOsUrl()).toBe("https://app.example.com");
  });

  it("accepts http (the local stack is not https)", () => {
    set("http://localhost:4320");
    expect(resellerOsUrl()).toBe("http://localhost:4320");
  });

  it("tolerates surrounding whitespace", () => {
    set("  https://app.example.com  ");
    expect(resellerOsUrl()).toBe("https://app.example.com");
  });
});

describe("resellerOsUrl — not usable", () => {
  it("unset → null", () => {
    expect(resellerOsUrl()).toBeNull();
  });

  it("empty → null, NOT the empty string", () => {
    set("");
    // "" would make every href relative — a link to the wrong app rather
    // than a visibly broken one.
    expect(resellerOsUrl()).toBeNull();
  });

  it("whitespace only → null", () => {
    set("   ");
    expect(resellerOsUrl()).toBeNull();
  });

  it("no scheme → null (a bare host resolves against the current path)", () => {
    set("app.example.com");
    expect(resellerOsUrl()).toBeNull();
  });

  it("a path with no scheme → null", () => {
    set("/dashboard");
    expect(resellerOsUrl()).toBeNull();
  });
});

describe("homeUrl", () => {
  it("configured → ResellerOS", () => {
    set("https://app.example.com");
    expect(homeUrl()).toBe("https://app.example.com");
  });

  it("unset → DMS's own root, so a standalone DMS still works", () => {
    expect(homeUrl()).toBe("/");
  });

  it("unusable value → DMS's own root, never an empty href", () => {
    set("app.example.com");
    expect(homeUrl()).toBe("/");
  });
});

describe("frontpageIsDelegated", () => {
  it("unset → false: DMS keeps its own homepage", () => {
    // The load-bearing default. Flipping it would switch off the homepage
    // of every DMS deployment that has not opted in.
    expect(frontpageIsDelegated()).toBe(false);
  });

  it("configured → true", () => {
    set("https://app.example.com");
    expect(frontpageIsDelegated()).toBe(true);
  });

  it("agrees with resellerOsUrl in every case", () => {
    for (const v of [undefined, "", "   ", "nope", "https://a.test"]) {
      set(v);
      expect(frontpageIsDelegated()).toBe(resellerOsUrl() !== null);
    }
  });
});
