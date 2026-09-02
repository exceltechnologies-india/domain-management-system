/**
 * END-TO-END PURCHASE → BILL JOURNEY (Primary Billing Integration).
 *
 * Drives the complete customer journey through the REAL route handlers:
 *
 *   POST /api/auth/register            (real validation, hashing, CSRF gate)
 *     -> POST /api/payments/create-order  (real plan lookup, price verify, order persist)
 *       -> POST /razorpay/webhook          (real HMAC verify, atomic claim, invoice, provisioning)
 *         -> GET /api/user/invoices        (what the customer sees)
 *           -> GET /api/orders/[id]/invoice (the bill they download)
 *
 * WHY THIS EXISTS: on 2026-09-02 the branch had 6227 passing unit tests, 181
 * passing integration tests, clean tsc/eslint and a green build — and still
 * contained three real bugs, two of them customer-money bugs:
 *
 *   1. The Order pre-save hook silently overwrote the legally-sequential
 *      `TI/YYYY-YY/NNNNN` tax-invoice number with a legacy random one, because
 *      the webhook's in-memory order predated the invoice write.
 *   2. Primary-invoiced orders matched the Zoho "stuck order" query, so the
 *      self-heal would have issued a SECOND tax invoice for the same payment.
 *   3. A fully paid bill rendered as "Generating invoice…" forever.
 *
 * All three lived in the seams BETWEEN components, which per-component tests
 * structurally cannot see. This suite is the regression net for that class of
 * bug — if you change anything in the purchase→invoice chain, this is the test
 * that tells you whether a real customer still gets a correct bill.
 *
 * ISOLATION: boots its own in-memory REPLICA SET, because the real
 * `finalizePendingOrder` completes the order inside a Mongo transaction and
 * standalone mongod refuses transactions. The shared integration setup boots a
 * standalone, so this file disconnects from it first. Costs ~10s of suite time.
 *
 * MOCKING BOUNDARY: only genuine external SaaS is stubbed — Razorpay,
 * DirectAdmin, ResellerClub, Zoho, email/WhatsApp, Meta. Everything else runs
 * for real: registration, auth, order creation, provisioning orchestration,
 * Hosting record creation, the payment transaction, GST math, invoice
 * numbering, PDF rendering, and every customer-facing read route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { IOrder } from "@/models/Order";

process.env.PRIMARY_BILLING_ENABLED = "true";
process.env.ZOHO_ORG_STATE = "Delhi";
const WEBHOOK_SECRET = "e2e_purchase_journey_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
// NextAuth's provider config dereferences these at import time.
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "e2e_google_id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "e2e_google_secret";

// ── External SaaS boundaries — the only things mocked ───────────────────────
vi.mock("@/lib/email", () => ({
  EmailService: new Proxy({}, { get: () => async () => undefined }),
}));
vi.mock("@/lib/whatsapp", () => ({
  WhatsAppService: new Proxy({}, { get: () => async () => undefined }),
}));
vi.mock("@/lib/meta-capi", () => ({ sendMetaServerEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

const rzpCreateOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: {
    createOrder: rzpCreateOrder,
    getPaymentDetails: vi.fn(),
    getOrderDetails: vi.fn(),
    verifyPayment: vi.fn(() => true),
    refundPayment: vi.fn(),
    createSubscription: vi.fn(),
    createCustomer: vi.fn(),
    createRecurringTokenOrder: vi.fn(),
  },
}));

vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: {
    getCustomerId: vi.fn(async () => ({ status: "error" })),
    modifyCustomer: vi.fn(async () => ({ status: "success" })),
    createCustomer: vi.fn(async () => ({ status: "success", data: 12345 })),
    getOrCreateCustomerAndContact: vi.fn(async () => ({
      status: "success",
      customerId: 111,
      contactId: 222,
    })),
    // `domcno` is RC's pricing key for .com (see lib/tld-mappings). The live
    // price must match the cart price or create-order 409s on PRICE_CHANGED.
    getDomainPricing: vi.fn(async () => ({
      customerPricing: { domcno: { addnewdomain: { "1": 800 } } },
    })),
  },
}));

const rcRegisterDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  registerDomain: rcRegisterDomain,
  getDomainOrderId: vi.fn(async () => "rc_order_1"),
}));

const daCreateUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  createUser: daCreateUser,
  suspendUser: vi.fn(async () => ({ kind: "suspended" })),
  unsuspendUser: vi.fn(async () => ({ kind: "unsuspended" })),
}));
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { NAMESERVERS: ["ns1.test.com", "ns2.test.com"] },
  DA_SERVER_IP: "10.0.0.9",
}));

const zohoCreateInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: {
    getInstance: () => ({
      getContactByEmail: vi.fn(async () => null),
      createContact: vi.fn(async () => null),
      updateContactDetails: vi.fn(async () => null),
      createInvoice: zohoCreateInvoice,
      getInvoicePdf: vi.fn(async () => null),
    }),
  },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

// ── Real application code under test ────────────────────────────────────────
const { POST: registerHandler } = await import("@/app/api/auth/register/route");
const { POST: createOrderHandler } = await import("@/app/api/payments/create-order/route");
const { POST: webhookHandler } = await import("@/app/razorpay/webhook/route");
const { GET: userInvoicesHandler } = await import("@/app/api/user/invoices/route");
const { GET: orderInvoicePdfHandler } = await import("@/app/api/orders/[id]/invoice/route");
const { AuthService } = await import("@/lib/auth");
const { listStuckZohoInvoiceOrders } = await import("@/lib/services/orders");
const { default: Order } = await import("@/models/Order");
const { default: User } = await import("@/models/User");
const { default: Hosting } = await import("@/models/Hosting");
const { default: Payment } = await import("@/models/Payment");
const { default: HostingPlan } = await import("@/models/HostingPlan");
const { default: Counter } = await import("@/models/Counter");

let replset: MongoMemoryReplSet;

beforeAll(async () => {
  // The shared setup connected mongoose to a STANDALONE server; the real
  // finalizePendingOrder runs inside a transaction, which needs a replica set.
  await mongoose.disconnect();
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replset.getUri();
  await mongoose.connect(replset.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await replset?.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db?.collections();
  for (const c of collections ?? []) await c.deleteMany({});
  vi.clearAllMocks();
  // Full reset, not just clearAllMocks: an unconsumed mockResolvedValueOnce
  // would otherwise leak into the next journey and hand it the wrong order id.
  rzpCreateOrder.mockReset();
  daCreateUser.mockReset().mockResolvedValue({ kind: "created", username: "e2euser1" });
  rcRegisterDomain.mockReset().mockResolvedValue({ kind: "registered", orderId: "rc_order_1" });
  zohoCreateInvoice.mockReset();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function signWebhook(raw: string) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
}

async function orderById(id: unknown): Promise<IOrder | null> {
  return (await Order.findById(id).lean()) as unknown as IOrder | null;
}

async function seedStarterPlan() {
  // Deliberately no `razorpayPlans` — that routes the hosting item down the
  // one-time-order path (a real production shape) rather than the Razorpay
  // Subscriptions rail, which bills through a different webhook entirely.
  await HostingPlan.create({
    planId: "starter",
    name: "Starter Hosting",
    description: "Entry plan",
    price: 999,
    renewalPrice: 999,
    currency: "INR",
    isActive: true,
    directAdminPackage: "starter_pkg",
    quota: 1024,
    bandwidth: 10240,
  });
}

async function registerCustomer(email: string, state: string) {
  const res = await registerHandler(
    new NextRequest("https://example.com/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "SuperSecret123!",
        firstName: "Priya",
        lastName: "Sharma",
        whatsappNumber: "9876543210",
        address: { line1: "42 MG Road", city: "City", state, zipcode: "560001", country: "IN" },
      }),
    })
  );
  expect(res.status).toBe(201);

  const user = await User.findOne({ email });
  expect(user).toBeTruthy();
  // A real, signed JWT — exactly what a login would hand the browser.
  const token = AuthService.generateToken({
    userId: String(user!._id),
    email: user!.email,
    role: user!.role,
  });
  return { user: user!, token };
}

async function buyHosting(
  token: string,
  opts: { rzpOrderId: string; amountPaise?: number; withDomain?: boolean }
) {
  rzpCreateOrder.mockResolvedValueOnce({
    id: opts.rzpOrderId,
    amount: opts.amountPaise ?? 99900,
    currency: "INR",
  });

  const cartItems: Record<string, unknown>[] = [
    {
      domainName: "realbiz-e2e.com",
      price: 999,
      currency: "INR",
      registrationPeriod: 1,
      itemType: "hosting",
      linkedDomain: "realbiz-e2e.com",
      // The real cart sends `id`; the route reads hostingPlan.id first and
      // persists planId onto the Order's domain row.
      hostingPlan: {
        id: "starter",
        planId: "starter",
        name: "Starter Hosting",
        serverPackage: "starter_pkg",
      },
    },
  ];
  if (opts.withDomain) {
    cartItems.unshift({
      domainName: "realbiz-e2e.com",
      price: 800,
      currency: "INR",
      registrationPeriod: 1,
      itemType: "domain",
    });
  }

  const res = await createOrderHandler(
    new NextRequest("https://example.com/api/payments/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cartItems }),
    })
  );
  expect(res.status).toBe(200);
  return res.json();
}

/** Simulates Razorpay confirming the payment via a validly-signed webhook. */
async function razorpayConfirmsPayment(
  rzpOrderId: string,
  internalOrderId: string,
  paymentId: string,
  amountPaise = 99900
) {
  const raw = JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: amountPaise,
          currency: "INR",
          order_id: rzpOrderId,
          notes: { receipt: internalOrderId },
        },
      },
    },
  });
  return webhookHandler(
    new NextRequest("https://example.com/razorpay/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": signWebhook(raw) },
      body: raw,
    })
  );
}

/** register → buy → pay, returning the fully-processed order. */
async function completePurchase(opts: {
  email: string;
  state: string;
  rzpOrderId: string;
  paymentId: string;
  withDomain?: boolean;
  amountPaise?: number;
}) {
  await seedStarterPlan();
  const { user, token } = await registerCustomer(opts.email, opts.state);
  await buyHosting(token, {
    rzpOrderId: opts.rzpOrderId,
    withDomain: opts.withDomain,
    amountPaise: opts.amountPaise,
  });
  const pending = await Order.findOne({ razorpayOrderId: opts.rzpOrderId });
  expect(pending).toBeTruthy();
  expect(pending!.status).toBe("pending");

  const res = await razorpayConfirmsPayment(
    opts.rzpOrderId,
    pending!.orderId,
    opts.paymentId,
    opts.amountPaise
  );
  expect(res.status).toBe(200);

  return { user, token, pendingId: pending!._id, internalOrderId: pending!.orderId };
}

// ════════════════════════════════════════════════════════════════════════════
describe("E2E: register → buy hosting → pay → provision → bill", () => {
  it("completes the order, provisions hosting, records the payment, and issues a primary tax invoice", async () => {
    const { pendingId } = await completePurchase({
      email: "delhi-cust@example.com",
      state: "Delhi",
      rzpOrderId: "order_A",
      paymentId: "pay_A",
    });

    const final = await orderById(pendingId);
    // The whole chain actually ran — not just the billing slice.
    expect(final?.status).toBe("completed");
    const hosting = await Hosting.findOne({ domainName: "realbiz-e2e.com" });
    expect(hosting).toBeTruthy();
    expect(hosting!.directAdminUsername).toBe("e2euser1");
    const payment = await Payment.findOne({ razorpayPaymentId: "pay_A" });
    expect(payment).toBeTruthy();
    expect(payment!.amount).toBe(999);

    // The bill itself.
    expect(final?.invoiceProvider).toBe("primary");
    expect(final?.invoiceNumber).toMatch(/^TI\/\d{4}-\d{2}\/\d{5}$/);
    expect(zohoCreateInvoice).not.toHaveBeenCalled();
  });

  it("bills CGST+SGST for an intra-state customer (company and customer both in Delhi)", async () => {
    const { pendingId } = await completePurchase({
      email: "delhi-cust@example.com",
      state: "Delhi",
      rzpOrderId: "order_B",
      paymentId: "pay_B",
    });

    const final = await orderById(pendingId);
    expect(final?.taxableValue).toBeCloseTo(846.61, 1); // 999 / 1.18
    expect(final?.cgst).toBeCloseTo(76.19, 1);
    expect(final?.sgst).toBeCloseTo(76.2, 1);
    expect(final?.igst).toBe(0);
    expect(final?.placeOfSupply).toBe("Delhi");
  });

  it("bills IGST only for an inter-state customer (Delhi company → Karnataka customer)", async () => {
    const { pendingId } = await completePurchase({
      email: "ka-cust@example.com",
      state: "Karnataka",
      rzpOrderId: "order_C",
      paymentId: "pay_C",
    });

    const final = await orderById(pendingId);
    expect(final?.igst).toBeCloseTo(152.39, 1);
    expect(final?.cgst).toBe(0);
    expect(final?.sgst).toBe(0);
    expect(final?.placeOfSupply).toBe("Karnataka");
  });

  it("bills the full cart total for a domain + hosting bundle and provisions both", async () => {
    const { pendingId } = await completePurchase({
      email: "bundle-cust@example.com",
      state: "Delhi",
      rzpOrderId: "order_D",
      paymentId: "pay_D",
      withDomain: true,
      amountPaise: 179900,
    });

    const final = await orderById(pendingId);
    expect(final?.orderType).toBe("bundle");
    expect(final?.amount).toBe(1799); // 800 domain + 999 hosting
    expect(final?.status).toBe("completed");
    expect(final?.invoiceProvider).toBe("primary");
    expect(final?.taxableValue).toBeCloseTo(1524.58, 1); // 1799 / 1.18
    expect(rcRegisterDomain).toHaveBeenCalled();
  });

  it("does not mint a second invoice number when Razorpay re-delivers the webhook", async () => {
    const { pendingId, internalOrderId } = await completePurchase({
      email: "dupe-cust@example.com",
      state: "Delhi",
      rzpOrderId: "order_E",
      paymentId: "pay_E",
    });
    const afterFirst = await orderById(pendingId);

    // Razorpay retries the same event.
    await razorpayConfirmsPayment("order_E", internalOrderId, "pay_E");
    const afterSecond = await orderById(pendingId);

    expect(afterSecond?.invoiceNumber).toBe(afterFirst?.invoiceNumber);
    const counter = await Counter.findOne({ key: /tax-invoice/ });
    expect(counter?.seq).toBe(1); // no number burned on the duplicate
  });

  it("issues sequential invoice numbers across separate purchases", async () => {
    await seedStarterPlan();
    const { token } = await registerCustomer("seq-cust@example.com", "Delhi");

    const numbers: string[] = [];
    for (const n of [1, 2, 3]) {
      await buyHosting(token, { rzpOrderId: `order_F${n}` });
      const pending = await Order.findOne({ razorpayOrderId: `order_F${n}` });
      await razorpayConfirmsPayment(`order_F${n}`, pending!.orderId, `pay_F${n}`);
      const final = await orderById(pending!._id);
      numbers.push(final!.invoiceNumber!);
    }

    expect(numbers[0]).toMatch(/00001$/);
    expect(numbers[1]).toMatch(/00002$/);
    expect(numbers[2]).toMatch(/00003$/);
  });

  it("lets the customer see the issued bill in their invoice list and download the PDF", async () => {
    const { token, pendingId } = await completePurchase({
      email: "view-cust@example.com",
      state: "Delhi",
      rzpOrderId: "order_G",
      paymentId: "pay_G",
    });
    const final = await orderById(pendingId);

    // (a) what /dashboard/invoices renders
    const listRes = await userInvoicesHandler(
      new NextRequest("https://example.com/api/user/invoices", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.invoices).toHaveLength(1);

    const row = listBody.invoices[0];
    expect(row.invoice_number).toBe(final?.invoiceNumber);
    expect(row.status).toBe("paid");
    expect(row.balance).toBe(0);
    expect(row.provider).toBe("primary");
    // REGRESSION: an issued bill must never advertise itself as still generating.
    expect(row.zoho_pending).toBe(false);

    // (b) the bill document itself
    const pdfRes = await orderInvoicePdfHandler(
      new NextRequest(`https://example.com/api/orders/${pendingId}/invoice`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(pendingId) }) }
    );
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get("content-disposition")).toContain("Tax-Invoice");
    const pdf = Buffer.from(await pdfRes.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("REGRESSION: never treats a primary-invoiced order as a stuck Zoho order (would double-bill)", async () => {
    const { user } = await completePurchase({
      email: "stuck-cust@example.com",
      state: "Delhi",
      rzpOrderId: "order_H",
      paymentId: "pay_H",
    });

    // The Zoho self-heal runs on every /dashboard/invoices load. A primary
    // invoice has no zohoInvoiceId by design — if it matched here, the customer
    // would receive a SECOND tax invoice for the same payment.
    const stuck = await listStuckZohoInvoiceOrders(String(user._id));
    expect(stuck).toHaveLength(0);
  });

  it("falls back to Zoho and still bills the customer when the primary engine is misconfigured", async () => {
    await seedStarterPlan();
    const { token } = await registerCustomer("fallback-cust@example.com", "Delhi");
    await buyHosting(token, { rzpOrderId: "order_I" });
    const pending = await Order.findOne({ razorpayOrderId: "order_I" });

    // Break the primary engine the way a real misconfiguration would.
    const savedState = process.env.ZOHO_ORG_STATE;
    delete process.env.ZOHO_ORG_STATE;
    process.env.ZOHO_REFRESH_TOKEN = "test_refresh_token";
    zohoCreateInvoice.mockResolvedValueOnce({
      invoice_id: "zoho_inv_I",
      invoice_number: "INV-000123",
    });

    try {
      await razorpayConfirmsPayment("order_I", pending!.orderId, "pay_I");
    } finally {
      process.env.ZOHO_ORG_STATE = savedState;
      delete process.env.ZOHO_REFRESH_TOKEN;
    }

    const final = await orderById(pending!._id);
    expect(zohoCreateInvoice).toHaveBeenCalled();
    expect(final?.zohoInvoiceId).toBe("zoho_inv_I");
    expect(final?.invoiceNumber).toBe("INV-000123");
    // The primary engine never claimed it, so no TI/... number was burned.
    expect(final?.invoiceProvider).toBeUndefined();
  });
});
