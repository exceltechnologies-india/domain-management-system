/**
 * Unit tests for lib/services/payment/verification.ts:validateOrderAmountMatchesRazorpay.
 *
 * Razorpay's `getOrderDetails` is the single external call — stub it and
 * exercise the comparison + the failure-path that converts a fetch error
 * into a 400 response. This is the underpayment-fraud gate that Batch 5a
 * mirrored from /verify into /guest/verify, so the assertion semantics
 * (rupee→paise rounding, mismatch → 400) need a regression guard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The shared unit-test setup stubs NextResponse.json to return undefined,
// which works for routes that just return the value upstream. This suite
// asserts on the response object's status + body, so override the stub
// locally to produce a Response-like envelope we can introspect.
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

vi.mock("@/lib/razorpay", () => ({
  RazorpayService: {
    getOrderDetails: vi.fn(),
  },
}));

import { RazorpayService } from "@/lib/razorpay";
import { validateOrderAmountMatchesRazorpay } from "@/lib/services/payment/verification";

afterEach(() => {
  vi.clearAllMocks();
});

describe("validateOrderAmountMatchesRazorpay", () => {
  it("returns ok when Razorpay-side paise equals DB rupees * 100", async () => {
    vi.mocked(RazorpayService.getOrderDetails).mockResolvedValue({
      amount: 99900,
    } as Awaited<ReturnType<typeof RazorpayService.getOrderDetails>>);

    const result = await validateOrderAmountMatchesRazorpay("rzp_ord_match", {
      amount: 999,
    });
    expect(result.ok).toBe(true);
  });

  it("returns 400 when Razorpay amount is less than DB amount (underpayment fraud)", async () => {
    // DB expects ₹999 (99900 paise); Razorpay only captured ₹1 (100 paise).
    vi.mocked(RazorpayService.getOrderDetails).mockResolvedValue({
      amount: 100,
    } as Awaited<ReturnType<typeof RazorpayService.getOrderDetails>>);

    const result = await validateOrderAmountMatchesRazorpay("rzp_ord_underpay", {
      amount: 999,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toMatch(/amount/i);
    }
  });

  it("returns 400 when Razorpay amount exceeds DB amount (cart tampering)", async () => {
    vi.mocked(RazorpayService.getOrderDetails).mockResolvedValue({
      amount: 200000,
    } as Awaited<ReturnType<typeof RazorpayService.getOrderDetails>>);

    const result = await validateOrderAmountMatchesRazorpay("rzp_ord_overpay", {
      amount: 999,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("handles rupee → paise rounding correctly (Math.round, not floor)", async () => {
    // DB has 9.999 rupees — rounds to 1000 paise.
    vi.mocked(RazorpayService.getOrderDetails).mockResolvedValue({
      amount: 1000,
    } as Awaited<ReturnType<typeof RazorpayService.getOrderDetails>>);

    const result = await validateOrderAmountMatchesRazorpay("rzp_ord_round", {
      amount: 9.999,
    });
    expect(result.ok).toBe(true);
  });

  it("converts a Razorpay fetch failure into a 400 (not a 500) so the caller bubbles a stable error", async () => {
    vi.mocked(RazorpayService.getOrderDetails).mockRejectedValue(
      new Error("razorpay unreachable")
    );

    const result = await validateOrderAmountMatchesRazorpay("rzp_ord_err", {
      amount: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toMatch(/verify/i);
    }
  });
});
