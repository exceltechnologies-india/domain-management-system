/**
 * DMS issues no bills (owner decision, 24 Sep 2026; built 25 Sep 2026).
 *
 * A SOURCE SCAN, not a unit test, because what it guards is an absence: the
 * TI/... engine (`createPrimaryInvoice`) and the legacy `INV-...` number the
 * Order pre-save hook used to mint were removed in the same commit, and the
 * failure this prevents is somebody reintroducing either. A unit test of the
 * remaining code cannot see a new caller.
 *
 * Comments are stripped before scanning (AGENTS.md L46): the files that
 * explain the removal name `createPrimaryInvoice` and `INV-` in prose, and
 * must be allowed to.
 *
 * Red-checked when written: re-adding a `createPrimaryInvoice(` call to
 * app/api/payments/verify/route.ts, and re-adding the INV template to
 * models/Order.ts, each turned this file red.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "models", "components", "scripts", "middleware"];
const EXT = /\.(ts|tsx|js|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name)) out.push(full);
  }
  return out;
}

/** Remove block and line comments, keeping string contents intact enough for this scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const sources = files.map((f) => ({ file: path.relative(ROOT, f), code: stripComments(readFileSync(f, "utf8")) }));

describe("DMS issues no bills — source scan", () => {
  it("actually scanned the app (guard against a scan of nothing)", () => {
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.some((s) => s.file.replace(/\\/g, "/") === "models/Order.ts")).toBe(true);
  });

  it("nothing calls, imports or defines createPrimaryInvoice", () => {
    const hits = sources.filter((s) => /\bcreatePrimaryInvoice\b/.test(s.code)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("the TI/... engine module is gone", () => {
    const hits = sources.filter((s) => /services\/billing\/createPrimaryInvoice/.test(s.code)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("no code mints an INV-... invoice number (the old Order pre-save hook)", () => {
    // The template literal the hook used: `INV-${…}`. A string that merely
    // mentions an existing legacy number is not a minting site.
    const hits = sources.filter((s) => /`INV-\$\{/.test(s.code) || /["']INV-["']\s*\+/.test(s.code)).map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("the Order pre-save hook no longer writes invoiceNumber", () => {
    const order = sources.find((s) => s.file.replace(/\\/g, "/") === "models/Order.ts");
    const hook = order!.code.slice(order!.code.indexOf('OrderSchema.pre("save"'));
    expect(hook).not.toMatch(/this\.invoiceNumber\s*=/);
  });

  it("nothing can allocate a TI/... number (the allocator is deleted)", () => {
    const hits = sources
      .filter((s) => /\ballocateInvoiceNumber\b|billing\/invoiceNumber|["'`]tax-invoice:/.test(s.code))
      .map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("the invoice claim/record helpers left in lib/services/orders.ts have no caller", () => {
    // Kept for now (their integration tests pin the double-billing guard on
    // historical data); nothing may start calling them again.
    const hits = sources
      .filter((s) => s.file.replace(/\\/g, "/") !== "lib/services/orders.ts")
      .filter((s) => /\b(claimOrderForPrimaryInvoice|recordPrimaryInvoiceForOrder|releasePrimaryInvoiceClaim)\b/.test(s.code))
      .map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("the three admin invoice actions stay removed", () => {
    const joined = sources.map((s) => s.code).join("\n");
    expect(joined).not.toMatch(/re-sync-invoice/);
    expect(joined).not.toMatch(/workers\/issue-invoice/);
    expect(joined).not.toMatch(/@\/lib\/invoice-retry/);
    expect(joined).not.toMatch(/invoices\/sync/);
  });
});
