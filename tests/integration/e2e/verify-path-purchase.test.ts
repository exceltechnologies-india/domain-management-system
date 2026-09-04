/**
 * END-TO-END PURCHASE VIA THE **VERIFY** ROUTE (the path a real browser takes).
 *
 *   POST /api/auth/register
 *     -> POST /api/payments/create-order
 *       -> POST /api/payments/verify        <-- what Razorpay Checkout's
 *          -> GET /api/user/invoices             handler actually calls
 *
 * WHY THIS EXISTS: the sibling suite `purchase-to-invoice.test.ts` drives
 * `/razorpay/webhook` — it contains ZERO references to `payments/verify`. But
 * the browser checkout never calls the webhook; Razorpay Checkout's client
 * handler POSTs to `/api/payments/verify`, and the webhook is a server-to-server
 * backstop that cannot reach a developer machine at all.
 *
 * So the route customers actually travel had no end-to-end coverage. On
 * 2026-09-04 a real Razorpay test-mode purchase (pay_TXrc4NyzAXMGuw, INR 1500)
 * came back HTTP 200 and left the order stranded:
 *
 *     status                  : processing   (never "completed")
 *     invoiceNumber           : null         (NO tax invoice for a paid customer)
 *     primaryInvoiceClaimedAt : null         (invoicing never even attempted)
 *     Hosting record          : never created
 *
 * — with no error logged and no SystemLog row, because the early-return at
 * verify/route.ts:184-194 answers "payment processed, provisioning in progress"
 * for any order already in `paid`/`processing` and returns BEFORE the claim,
 * the finalisation and the invoicing. Anything that reaches that guard with the
 * order already advanced silently ends the journey.
 *
 * These tests pin the two properties that matter to a paying customer:
 *   1. a single verify call completes the order AND issues the tax invoice;
 *   2. a repeated verify call (retry, double-submit, StrictMode double-invoke)
 *      never leaves the order stranded without an invoice.
 *
 * ISOLATION + MOCKING BOUNDARY: identical to the webhook suite — its own
 * in-memory REPLICA SET (finalizePendingOrder needs a transaction; standalone
 * mongod refuses them), and only genuine external SaaS stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { IOrder } from "@/models/Order";

// No invoicing flag is set on purpose: the primary GST engine is permanent and
// the Zoho fallback defaults on, so this runs exactly as production does.
process.env.ZOHO_ORG_STATE = "Delhi";
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
const rzpGetPaymentDetails = vi.hoisted(() => vi.fn());
const rzpGetOrderDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: {
    createOrder: rzpCreateOrder,
    getPaymentDetails: rzpGetPaymentDetails,
    getOrderDetails: rzpGetOrderDetails,
    // The signature gate itself is unit-tested elsewhere; here it must pass so
    // the journey can proceed to the parts this suite is about.
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
const { POST: verifyHandler } = await import("@/app/api/payments/verify/route");
const { GET: userInvoicesHandler } = await import("@/app/api/user/invoices/route");
const { AuthService } = await import("@/lib/auth");
const { default: Order } = await import("@/models/Order");
const { default: User } = await import("@/models/User");
const { default: Hosting } = await import("@/models/Hosting");
const { default: HostingPlan } = await import("@/models/HostingPlan");

let replset: MongoMemoryReplSet;

beforeAll(async () => {
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
  rzpCreateOrder.mockReset();
  rzpGetPaymentDetails.mockReset();
  rzpGetOrderDetails.mockReset();
  daCreateUser.mockReset().mockResolvedValue({ kind: "created", username: "verifyuser1" });
  rcRegisterDomain.mockReset().mockResolvedValue({ kind: "registered", orderId: "rc_order_1" });
  zohoCreateInvoice.mockReset();
});

// ── Helpers ─────────────────────────────────────────────────────────────────
const RZP_ORDER = "order_verify_e2e_1";
const PAYMENT_ID = "pay_verify_e2e_1";
const PRICE = 1500;
const PAISE = PRICE * 100;

async function seedStandardPlan() {
  await HostingPlan.create({
    planId: "standard",
    name: "Standard Hosting",
    description: "Growing business sites",
    price: PRICE,
    renewalPrice: PRICE,
    currency: "INR",
    isActive: true,
    directAdminPackage: "standard_pkg",
    quota: 2048,
    bandwidth: 20480,
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
        firstName: "Raju",
        lastName: "Sharma",
        whatsappNumber: "9876543210",
        address: { line1: "42 MG Road", city: "Mumbai", state, zipcode: "400001", country: "IN" },
      }),
    })
  );
  expect(res.status).toBe(201);
  const user = await User.findOne({ email });
  expect(user).toBeTruthy();
  const token = AuthService.generateToken({
    userId: String(user!._id),
    email: user!.email,
    role: user!.role,
  });
  return { user: user!, token };
}

/**
 * The exact cart shape the browser sends for "hosting plan only": a
 * placeholder domainName plus a linkedDomain the customer typed in the cart.
 * This is what the 2026-09-04 live purchase looked like.
 */
async function buyHostingWithLinkedDomain(token: string) {
  rzpCreateOrder.mockResolvedValueOnce({ id: RZP_ORDER, amount: PAISE, currency: "INR" });
  const res = await createOrderHandler(
    new NextRequest("https://example.com/api/payments/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        cartItems: [
          {
            domainName: "hosting-Standard-1788502345704",
            linkedDomain: "verify-e2e.com",
            price: PRICE,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "hosting",
            hostingPlan: {
              id: "standard",
              planId: "standard",
              name: "Standard Hosting",
              serverPackage: "standard_pkg",
            },
          },
        ],
      }),
    })
  );
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * Drives the REAL verify route exactly as Razorpay Checkout's handler does.
 *
 * `signature` defaults to the normal one-shot case. Pass `undefined` explicitly
 * via { omitSignature: true } to model the mandate/Tokens flow, where Razorpay
 * hands the client no usable HMAC and the route normalises it to "".
 */
async function browserConfirmsPayment(
  token: string,
  opts: { omitSignature?: boolean } = {}
) {
  rzpGetPaymentDetails.mockResolvedValue({
    id: PAYMENT_ID,
    order_id: RZP_ORDER,
    amount: PAISE,
    currency: "INR",
    status: "captured",
    captured: true,
    notes: {},
  });
  rzpGetOrderDetails.mockResolvedValue({ id: RZP_ORDER, amount: PAISE, currency: "INR" });

  return verifyHandler(
    new NextRequest("https://example.com/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        razorpay_order_id: RZP_ORDER,
        razorpay_payment_id: PAYMENT_ID,
        ...(opts.omitSignature
          ? {}
          : { razorpay_signature: "valid_signature_mocked_true" }),
        cartItems: [
          {
            domainName: "hosting-Standard-1788502345704",
            linkedDomain: "verify-e2e.com",
            price: PRICE,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "hosting",
          },
        ],
      }),
    })
  );
}

async function reloadOrder(): Promise<IOrder | null> {
  return (await Order.findOne({ razorpayOrderId: RZP_ORDER }).lean()) as unknown as IOrder | null;
}

// ── The journey ─────────────────────────────────────────────────────────────
describe("purchase via /api/payments/verify (the browser's path)", () => {
  it("**a single verify call completes the order AND issues the tax invoice**", async () => {
    await seedStandardPlan();
    const { token } = await registerCustomer("verify-e2e@example.test", "Maharashtra");
    await buyHostingWithLinkedDomain(token);

    const res = await browserConfirmsPayment(token);
    expect(res.status).toBe(200);

    const order = await reloadOrder();
    expect(order).toBeTruthy();

    // The customer paid. These are the two things they are owed.
    expect(order!.status).toBe("completed");
    expect(order!.invoiceNumber).toMatch(/^TI\/\d{4}-\d{2}\/\d{5}$/);
    expect(order!.invoiceProvider).toBe("primary");
  });

  it("records the real payment id on the order (not the 'pending' placeholder)", async () => {
    await seedStandardPlan();
    const { token } = await registerCustomer("verify-e2e2@example.test", "Maharashtra");
    await buyHostingWithLinkedDomain(token);
    await browserConfirmsPayment(token);

    const order = await reloadOrder();
    expect(order!.razorpayPaymentId).toBe(PAYMENT_ID);
  });

  it("computes GST inter-state (Delhi seller -> Maharashtra customer = IGST only)", async () => {
    await seedStandardPlan();
    const { token } = await registerCustomer("verify-e2e3@example.test", "Maharashtra");
    await buyHostingWithLinkedDomain(token);
    await browserConfirmsPayment(token);

    const order = await reloadOrder();
    expect(order!.gstRate).toBe(18);
    expect(order!.cgst).toBe(0);
    expect(order!.sgst).toBe(0);
    expect(order!.igst).toBeGreaterThan(0);
    // Taxable + tax must reconcile to exactly what was charged.
    const total = Number(order!.taxableValue) + Number(order!.igst);
    expect(Math.round(total * 100) / 100).toBe(PRICE);
  });

  it("creates the Hosting record for the linked domain", async () => {
    await seedStandardPlan();
    const { token } = await registerCustomer("verify-e2e4@example.test", "Maharashtra");
    await buyHostingWithLinkedDomain(token);
    await browserConfirmsPayment(token);

    const hosting = await Hosting.findOne({ domainName: "verify-e2e.com" }).lean();
    expect(hosting).toBeTruthy();
  });

  it("the customer can see the invoice in their invoice list", async () => {
    await seedStandardPlan();
    const { token } = await registerCustomer("verify-e2e5@example.test", "Maharashtra");
    await buyHostingWithLinkedDomain(token);
    await browserConfirmsPayment(token);

    const res = await userInvoicesHandler(
      new NextRequest("https://example.com/api/user/invoices", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.invoices)).toBe(true);
    expect(body.invoices.length).toBeGreaterThan(0);
    expect(body.invoices[0].invoice_number).toMatch(/^TI\//);
  });

  // ── The stranding regression ──────────────────────────────────────────────
  //
  // verify/route.ts:184-194 short-circuits any order already in
  // `paid`/`processing` with "provisioning in progress", BEFORE the claim,
  // finalisation and invoicing. A retry, a double-submit or a StrictMode
  // double-invoke must therefore never be able to end the journey with the
  // customer charged and no invoice.
  describe("REGRESSION: a repeated verify call must not strand the order", () => {
    it("**calling verify twice still leaves a completed order with a tax invoice**", async () => {
      await seedStandardPlan();
      const { token } = await registerCustomer("verify-e2e6@example.test", "Maharashtra");
      await buyHostingWithLinkedDomain(token);

      const first = await browserConfirmsPayment(token);
      expect(first.status).toBe(200);
      const second = await browserConfirmsPayment(token);
      expect(second.status).toBe(200);

      const order = await reloadOrder();
      expect(order!.status).toBe("completed");
      expect(order!.invoiceNumber).toMatch(/^TI\//);
    });

    it("**two CONCURRENT verify calls issue exactly one invoice number**", async () => {
      await seedStandardPlan();
      const { token } = await registerCustomer("verify-e2e7@example.test", "Maharashtra");
      await buyHostingWithLinkedDomain(token);

      // The realistic double-submit: both in flight before either finishes.
      const [a, b] = await Promise.all([
        browserConfirmsPayment(token),
        browserConfirmsPayment(token),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const order = await reloadOrder();
      expect(order!.status).toBe("completed");
      expect(order!.invoiceNumber).toMatch(/^TI\//);

      // One payment must never consume two numbers in the legal series.
      const numbered = await Order.countDocuments({
        invoiceNumber: { $exists: true, $ne: null },
      });
      expect(numbered).toBe(1);
    });

    // ── Regression: the mandate flow's missing client signature ────────────
    //
    // Razorpay's recurring/Tokens authorization hands the client no usable
    // HMAC, so /verify normalises it to `razorpay_signature ?? ""`. The Order
    // schema had `razorpaySignature: { required: true }`, and Mongoose rejects
    // an empty string for a required String — so finalizePendingOrder's
    // `order.save()` threw "Path `razorpaySignature` is required" AFTER
    // provisioning had already run. Reproduced on 2026-09-04 against a real
    // captured Razorpay test payment: the DirectAdmin account was created, the
    // Hosting row written and the welcome email sent, then the save blew up,
    // the catch marked the order for support, and /verify still answered
    // HTTP 200 `success: true`. The customer's order sat at "processing" with
    // no invoice, and the dashboard showed nothing.
    //
    // Everything the paying customer is owed must survive an absent signature.
    it("**completes the order and invoices it when the client sends NO signature**", async () => {
      await seedStandardPlan();
      const { token } = await registerCustomer("verify-e2e8@example.test", "Maharashtra");
      await buyHostingWithLinkedDomain(token);

      const res = await browserConfirmsPayment(token, { omitSignature: true });
      expect(res.status).toBe(200);

      const order = await reloadOrder();
      expect(order!.status).toBe("completed");
      expect(order!.invoiceNumber).toMatch(/^TI\/\d{4}-\d{2}\/\d{5}$/);
      expect(order!.invoiceProvider).toBe("primary");
      // The order must NOT be left stranded for support.
      expect(order!.paymentVerification?.paymentStatus).not.toBe(
        "captured_pending_support"
      );
    });

    it("provisions hosting when the client sends NO signature", async () => {
      await seedStandardPlan();
      const { token } = await registerCustomer("verify-e2e9@example.test", "Maharashtra");
      await buyHostingWithLinkedDomain(token);

      await browserConfirmsPayment(token, { omitSignature: true });

      expect(await Hosting.countDocuments({ domainName: "verify-e2e.com" })).toBe(1);
    });
  });
});
