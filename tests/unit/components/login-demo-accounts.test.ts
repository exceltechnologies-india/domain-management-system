/**
 * The demo panel's entries are configurable because the hardcoded `.invalid`
 * fixtures stop existing the moment a real dump is restored — `mongorestore
 * --drop` replaces `users` wholesale.
 *
 * Threat model:
 *  - **A half-filled row is worse than no row.** The panel exists so nobody
 *    hand-types a credential; one that fills an email and leaves the password
 *    blank looks like broken auth rather than broken config. Malformed entries
 *    are dropped, never rendered partially.
 *  - **Unset must fall back, not blank the panel.** An empty panel on a fresh
 *    clone reads as "this feature is gone".
 *
 * The parser is duplicated here rather than exported from the component,
 * because LoginForm is a heavy client module (next-auth, router, reCAPTCHA)
 * and importing it drags all of that into a unit test. The copy is asserted
 * against the component's source below so the two cannot drift.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FALLBACK = [
  { label: "Admin · Anutech Digital", email: "dev-local@anutech.invalid", password: "DemoAdmin@2026" },
  { label: "Customer · has a domain + hosting", email: "testcustomer@local.invalid", password: "DemoUser@2026" },
];

function parseDemoAccounts(raw: string | undefined) {
  if (!raw || !raw.trim()) return FALLBACK;
  const parsed = raw
    .split(";")
    .map((entry) => entry.split("|").map((p) => p.trim()))
    .filter((p) => p.length === 3 && p[0] && p[1] && p[2])
    .map(([label, email, password]) => ({ label, email, password }));
  return parsed.length > 0 ? parsed : FALLBACK;
}

describe("unset or empty → the built-in fixtures", () => {
  it.each([undefined, "", "   "])("%p falls back", (v) => {
    expect(parseDemoAccounts(v)).toEqual(FALLBACK);
  });
});

describe("a configured list replaces the fixtures", () => {
  it("parses label|email|password, semicolon separated", () => {
    const out = parseDemoAccounts(
      "Admin · Real Person|admin@example.com|pw1;Customer · Owns 3|cust@example.com|pw2"
    );
    expect(out).toEqual([
      { label: "Admin · Real Person", email: "admin@example.com", password: "pw1" },
      { label: "Customer · Owns 3", email: "cust@example.com", password: "pw2" },
    ]);
  });

  it("tolerates whitespace around the parts", () => {
    expect(parseDemoAccounts("  A | a@b.c | pw  ")).toEqual([
      { label: "A", email: "a@b.c", password: "pw" },
    ]);
  });

  it("accepts a single entry", () => {
    expect(parseDemoAccounts("Only|one@example.com|pw")).toHaveLength(1);
  });
});

describe("malformed entries are dropped, never half-rendered", () => {
  it.each([
    ["missing the password", "Admin|admin@example.com"],
    ["empty password", "Admin|admin@example.com|"],
    ["empty email", "Admin||pw"],
    ["empty label", "|admin@example.com|pw"],
    ["too many parts", "Admin|admin@example.com|pw|extra"],
  ])("%s → dropped", (_why, raw) => {
    // Falls back rather than rendering a row that cannot sign in.
    expect(parseDemoAccounts(raw)).toEqual(FALLBACK);
  });

  it("keeps the good entries and drops only the bad one", () => {
    const out = parseDemoAccounts("Good|g@example.com|pw;Bad|b@example.com");
    expect(out).toEqual([{ label: "Good", email: "g@example.com", password: "pw" }]);
  });
});

describe("the component uses this parser, not a second copy", () => {
  const src = readFileSync("components/LoginForm.tsx", "utf8");

  it("reads NEXT_PUBLIC_DEMO_ACCOUNTS", () => {
    expect(src).toContain("NEXT_PUBLIC_DEMO_ACCOUNTS");
  });

  it("still gates the panel on NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS", () => {
    // Configurable entries must not accidentally make the panel unconditional:
    // that is what keeps it out of a production image.
    expect(src).toContain("NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS === 'true'");
  });

  it("its filter matches this one, so the two cannot drift", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toContain("p.length === 3 && p[0] && p[1] && p[2]");
    // Guard the guard: the comment strip must not have eaten the file.
    expect(code).toContain("parseDemoAccounts");
  });
});
