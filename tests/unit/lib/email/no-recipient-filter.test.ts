/**
 * No recipient filter (owner, 30 Sep 2026: "remove this restriction … permanently"). The
 * EMAIL_RECIPIENT_ALLOWLIST of 29 Sep kept every email outside @anutech.in from leaving this
 * machine, and the owner could not test the app. It was removed from the code, not just
 * unset; this fails if it comes back.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

describe("no recipient filter", () => {
  it("the filter module is gone and sendEmail does not read the setting", () => {
    expect(existsSync("lib/email/recipient-allowlist.ts")).toBe(false);
    const code = readFileSync("lib/email/transporter.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/EMAIL_RECIPIENT_ALLOWLIST|recipientAllowed/);
  });
});

describe("SMTP connects over IPv4 (30 Sep 2026)", () => {
  it("resolves the host to IPv4 and keeps the real name for TLS", () => {
    const code = readFileSync("lib/email/transporter.ts", "utf8");
    expect(code).toMatch(/lookup\(SMTP_HOST!, \{ family: 4 \}\)/);
    expect(code).toMatch(/host: ipv4 \?\? SMTP_HOST/);
    expect(code).toMatch(/tls: \{ servername: SMTP_HOST \}/);
  });
});
