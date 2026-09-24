/**
 * Migration 009 against a REAL MongoDB (mongodb-memory-server), not a mock.
 *
 * The step that matters for money is the first one: an order Zoho already
 * invoiced must come out stamped `invoiceProvider: "zoho"`, because that is
 * what makes every retry path and the engine's own claim refuse it. If the
 * stamp were lost, the order would read "paid, never invoiced" and a retry
 * could issue a SECOND tax invoice for a payment Zoho already invoiced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { up } from "@/scripts/db/migrations/009_retire_zoho_invoice_fields";

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "m009" });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const orders = () => mongoose.connection.collection("orders");

beforeEach(async () => {
  await orders().deleteMany({});
});

describe("migration 009 — retire Zoho invoice fields", () => {
  it("stamps a Zoho-invoiced order invoiceProvider 'zoho' and removes the Zoho id", async () => {
    await orders().insertOne({ orderId: "o-zoho", zohoInvoiceId: "4655000000123", invoiceNumber: "INV-000033" });
    await up(mongoose.connection);
    const o = await orders().findOne({ orderId: "o-zoho" });
    expect(o?.invoiceProvider).toBe("zoho");
    expect(o).not.toHaveProperty("zohoInvoiceId");
    expect(o?.invoiceNumber).toBe("INV-000033");
    expect(o).not.toHaveProperty("invoiceFailedAt");
  });

  it("never overwrites an existing invoiceProvider", async () => {
    await orders().insertOne({ orderId: "o-primary", invoiceProvider: "primary", zohoInvoiceId: "stray" });
    await up(mongoose.connection);
    const o = await orders().findOne({ orderId: "o-primary" });
    expect(o?.invoiceProvider).toBe("primary");
  });

  it("turns the creation_failed and pending_creation sentinels into invoiceFailedAt, not an invoice", async () => {
    const updatedAt = new Date("2026-09-01T10:00:00Z");
    await orders().insertMany([
      { orderId: "o-failed", zohoInvoiceId: "creation_failed", updatedAt },
      { orderId: "o-pending", zohoInvoiceId: "pending_creation", updatedAt },
    ]);
    await up(mongoose.connection);
    for (const id of ["o-failed", "o-pending"]) {
      const o = await orders().findOne({ orderId: id });
      expect(o).not.toHaveProperty("invoiceProvider");
      expect(o?.invoiceFailedAt).toEqual(updatedAt);
      expect(o?.invoiceFailureReason).toMatch(/migration 009/);
      expect(o).not.toHaveProperty("zohoInvoiceId");
    }
  });

  it("leaves an order with no Zoho id alone", async () => {
    await orders().insertOne({ orderId: "o-none", amount: 599.88 });
    await up(mongoose.connection);
    const o = await orders().findOne({ orderId: "o-none" });
    expect(o).not.toHaveProperty("invoiceProvider");
    expect(o).not.toHaveProperty("invoiceFailedAt");
  });

  it("strips the per-line zohoRecurring fields and keeps the rest of the line", async () => {
    await orders().insertOne({
      orderId: "o-lines",
      domains: [
        { domainName: "a.in", zohoRecurringProfileStatus: "pending", zohoRecurringInvoiceId: "r1" },
        { domainName: "b.in", zohoRecurringProfileStatus: "created" },
      ],
    });
    await up(mongoose.connection);
    const o = await orders().findOne({ orderId: "o-lines" });
    expect(o?.domains).toEqual([{ domainName: "a.in" }, { domainName: "b.in" }]);
  });

  it("drops the zohoInvoiceId index, and is safe to run twice", async () => {
    await orders().createIndex({ zohoInvoiceId: 1 }, { sparse: true });
    await orders().insertOne({ orderId: "o-zoho", zohoInvoiceId: "z1" });
    await up(mongoose.connection);
    await up(mongoose.connection);
    const names = (await orders().indexes()).map((i) => i.name);
    expect(names).not.toContain("zohoInvoiceId_1");
    const o = await orders().findOne({ orderId: "o-zoho" });
    expect(o?.invoiceProvider).toBe("zoho");
  });
});
