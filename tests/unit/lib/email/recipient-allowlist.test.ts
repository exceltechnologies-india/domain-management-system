/**
 * EMAIL_RECIPIENT_ALLOWLIST keeps a dev stack with a real SMTP login from mailing
 * the real customers in its local data (29 Sep 2026). Unset = no filter, which is
 * what production needs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { parseAllowlist, recipientAllowed } from "@/lib/email/recipient-allowlist";

describe("recipientAllowed", () => {
  it("unset or blank → no filter (production)", () => {
    expect(recipientAllowed("anyone@gmail.com", undefined).allowed).toBe(true);
    expect(recipientAllowed("anyone@gmail.com", "  ").allowed).toBe(true);
  });

  it("an @domain entry allows that domain only, not a lookalike or a subdomain", () => {
    const list = "@anutech.in";
    expect(recipientAllowed("pawan@anutech.in", list).allowed).toBe(true);
    expect(recipientAllowed("PAWAN@Anutech.IN", list).allowed).toBe(true);
    expect(recipientAllowed("x@notanutech.in", list).allowed).toBe(false);
    expect(recipientAllowed("x@mail.anutech.in", list).allowed).toBe(false);
  });

  it("a plain entry allows that exact address only", () => {
    const list = "tester@gmail.com";
    expect(recipientAllowed("tester@gmail.com", list).allowed).toBe(true);
    expect(recipientAllowed("other@gmail.com", list).allowed).toBe(false);
  });

  it("a real customer not on the list is refused, with a reason naming them", () => {
    const d = recipientAllowed("owner@srigangatechnologies.com", "@anutech.in, pawan@exceltechnologies.in");
    expect(d).toEqual({ allowed: false, reason: expect.stringContaining("owner@srigangatechnologies.com") });
  });

  it("parses commas, semicolons and spaces", () => {
    expect(parseAllowlist("@a.in; b@c.com  d@e.com")).toEqual(["@a.in", "b@c.com", "d@e.com"]);
  });
});

describe("the one mail chokepoint applies it before opening SMTP", () => {
  const src = readFileSync("lib/email/transporter.ts", "utf8");
  it("sendEmail checks the allow-list before getTransporter()", () => {
    const body = src.slice(src.indexOf("export async function sendEmail"));
    const gate = body.indexOf("recipientAllowed(options.to, process.env.EMAIL_RECIPIENT_ALLOWLIST)");
    const smtp = body.indexOf("getTransporter()");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(smtp);
  });
  it("it is the only sendMail in lib/ and app/, so nothing can go around it", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /\.sendMail\(/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk("lib"); walk("app");
    expect(hits).toEqual(["lib/email/transporter.ts"]);
    expect(src.match(/\.sendMail\(/g)?.length).toBe(1);
  });
});
