/**
 * GUARD: DMS renewal reminders carry no DMS price (owner, 26 Sep 2026:
 * "Point to the ResellerOS quote"). Renewals are ResellerOS's, so a reminder
 * may link to the ResellerOS quote but must never print an amount of its own.
 *
 * A source scan (comments stripped): the reminder template and the worker that
 * sends it must not read or pass a price/amount field, and the deleted
 * renewal-invoice email (which printed a DMS `invoiceAmount`) must not return.
 * Red-checked when written: re-adding `amount: service.price` to the worker,
 * and a `₹${details.amount}` line to the template, each turned it red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const read = (f: string) => strip(readFileSync(path.join(process.cwd(), f), "utf8"));

/** The body of `export async function <name>(` up to the next top-level export. */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = code.indexOf("\nexport ", start + 1);
  return code.slice(start, next < 0 ? undefined : next);
}

const PRICE = /\b(amount|price|invoiceAmount|renewalPrice|currency|chargeAmount)\b|₹\s*\$\{/;

describe("renewal reminders carry no DMS price", () => {
  it("sendServiceReminderEmail has no price field and prints no rupee figure", () => {
    const body = fnBody(read("lib/email/domain.ts"), "sendServiceReminderEmail");
    expect(body.match(PRICE)?.[0] ?? null).toBeNull();
  });

  it("the expiry worker's reminder call passes no price", () => {
    const code = read("app/api/workers/process-service-expiry/route.ts");
    const call = code.slice(code.indexOf("sendServiceReminderEmail("), code.indexOf("sendServiceReminderEmail(") + 600);
    expect(call).toMatch(/renewal/);
    expect(call.match(PRICE)?.[0] ?? null).toBeNull();
    expect(code).not.toMatch(/service\.price|service\.currency/);
  });

  it("the DMS renewal-invoice email stays deleted", () => {
    expect(read("lib/email/domain.ts")).not.toMatch(/sendRenewalInvoiceEmail/);
    expect(read("lib/email/index.ts")).not.toMatch(/sendRenewalInvoiceEmail/);
  });
});
