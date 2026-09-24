/**
 * Component tests for the customer invoices panel (/dashboard/invoices).
 *
 * HISTORY. On 2026-09-02 this table was made provider-aware, because every
 * action was gated on a Zoho invoice id and a primary-engine tax invoice has
 * none. On 2026-09-24 Zoho Books was removed from the app by owner decision,
 * and with it the "Pay Now" flow (its Razorpay checkout paid a Zoho invoice).
 * What is pinned now:
 *   - `invoice_id` is the ORDER id and is set only once an invoice is issued;
 *     View → /dashboard/invoices/<id>/view, Download → /api/v1/orders/<id>/invoice
 *   - a paid row whose invoice attempt FAILED (`invoice_failed`) offers the
 *     "Generating · Retry" pill, which posts to /api/v1/user/invoices/sync
 *   - while any row is failed the list re-polls every 30s
 *   - there is no Pay Now button and nothing calls /api/v1/user/invoices/<id>/pay
 *     (that route was deleted)
 *
 * The API-side half is covered by tests/unit/app/api/user/invoices/route.test.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const swrData = vi.hoisted(() => ({ current: undefined as unknown }));
const mutate = vi.hoisted(() => vi.fn());
vi.mock("swr", () => ({
  default: () => ({
    data: swrData.current,
    isLoading: false,
    isValidating: false,
    mutate,
  }),
}));

vi.mock("@/hooks/useUser", () => ({
  useUser: () => ({ user: { id: "U1", email: "a@x.test", firstName: "A", lastName: "B" }, isLoading: false }),
}));

vi.mock("@/components/user/UserLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/skeletons/PageSkeletons", () => ({
  DashboardLayoutSkeleton: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InvoicesPageSkeleton: () => <div>loading</div>,
}));
vi.mock("@/components/dashboard/RefreshButton", () => ({
  default: () => <button type="button">Refresh</button>,
}));

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { post: apiPost } }));
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));
vi.mock("@/lib/logout", () => ({ performLogout: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/toast", () => ({ showSuccessToast: vi.fn(), showErrorToast: vi.fn() }));

import InvoicesPage from "@/app/dashboard/invoices/page";

/** An issued invoice — `invoice_id` is the order id. */
function issuedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: "ord_1",
    invoice_number: "TI/2026-27/00001",
    date: "2026-09-01T10:00:00.000Z",
    due_date: "2026-09-01T10:00:00.000Z",
    created_time: "2026-09-01T10:00:00.000Z",
    total: 999,
    balance: 0,
    status: "paid",
    currency_code: "INR",
    order_id: "ord_1",
    invoice_failed: false,
    ...overrides,
  };
}

/** Paid, but the invoice attempt failed — no document yet. */
function failedInvoice(overrides: Record<string, unknown> = {}) {
  return issuedInvoice({
    invoice_id: "",
    invoice_number: "",
    order_id: "ord_failed",
    invoice_failed: true,
    ...overrides,
  });
}

/** An unpaid order — the old page offered "Pay Now" on exactly this row. */
function unpaidInvoice(overrides: Record<string, unknown> = {}) {
  return issuedInvoice({
    invoice_id: "",
    invoice_number: "",
    order_id: "ord_unpaid",
    status: "sent",
    balance: 999,
    invoice_failed: false,
    ...overrides,
  });
}

const RETRY_PILL = /Generating · Retry/;

beforeEach(() => {
  push.mockReset();
  mutate.mockReset();
  apiPost.mockReset();
  swrData.current = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, blob: async () => new Blob(["%PDF-"]) }))
  );
  // jsdom has no object-URL plumbing
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<InvoicesPage> — an issued invoice", () => {
  it("shows the number with View and Download, and no retry pill", () => {
    swrData.current = { invoices: [issuedInvoice()] };
    render(<InvoicesPage />);

    expect(screen.getByText("TI/2026-27/00001")).toBeInTheDocument();
    expect(screen.getByTitle("View invoice")).toBeInTheDocument();
    expect(screen.getByTitle("Download PDF")).toBeInTheDocument();
    expect(screen.queryByText(RETRY_PILL)).not.toBeInTheDocument();
  });

  it("View opens /dashboard/invoices/<order id>/view with no ?src=order", async () => {
    swrData.current = { invoices: [issuedInvoice()] };
    render(<InvoicesPage />);

    await userEvent.click(screen.getByTitle("View invoice"));

    expect(push).toHaveBeenCalledWith("/dashboard/invoices/ord_1/view");
  });

  it("Download fetches the orderId-keyed route", async () => {
    swrData.current = { invoices: [issuedInvoice()] };
    render(<InvoicesPage />);

    await userEvent.click(screen.getByTitle("Download PDF"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/v1/orders/ord_1/invoice");
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("renders two invoices as distinct rows", () => {
    swrData.current = {
      invoices: [
        issuedInvoice({ invoice_number: "TI/2026-27/00001", invoice_id: "ord_1", order_id: "ord_1" }),
        issuedInvoice({ invoice_number: "TI/2026-27/00002", invoice_id: "ord_2", order_id: "ord_2" }),
      ],
    };
    render(<InvoicesPage />);

    expect(screen.getByText("TI/2026-27/00001")).toBeInTheDocument();
    expect(screen.getByText("TI/2026-27/00002")).toBeInTheDocument();
    expect(screen.getAllByTitle("Download PDF")).toHaveLength(2);
  });
});

describe("<InvoicesPage> — a paid order whose invoice attempt failed", () => {
  it("shows the retry pill and no View/Download", () => {
    swrData.current = { invoices: [failedInvoice()] };
    render(<InvoicesPage />);

    expect(screen.getByText(RETRY_PILL)).toBeInTheDocument();
    expect(screen.queryByTitle("Download PDF")).not.toBeInTheDocument();
    expect(screen.queryByTitle("View invoice")).not.toBeInTheDocument();
  });

  it("pressing Retry posts to the sync route and refreshes the list", async () => {
    apiPost.mockResolvedValue({ ok: true, data: { recovered: 1, failed: 0, total: 1 } });
    swrData.current = { invoices: [failedInvoice()] };
    render(<InvoicesPage />);

    await userEvent.click(screen.getByText(RETRY_PILL));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith("/api/v1/user/invoices/sync", undefined);
  });

  it("an issued row and a failed row side by side each get their own actions", () => {
    swrData.current = { invoices: [issuedInvoice(), failedInvoice()] };
    render(<InvoicesPage />);

    expect(screen.getAllByTitle("View invoice")).toHaveLength(1);
    expect(screen.getAllByTitle("Download PDF")).toHaveLength(1);
    expect(screen.getAllByText(RETRY_PILL)).toHaveLength(1);
  });

  it("re-polls every 30s while a row is failed", () => {
    vi.useFakeTimers();
    swrData.current = { invoices: [failedInvoice()] };
    render(<InvoicesPage />);

    expect(mutate).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(30000); });
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(30000); });
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it("does not poll when every row is issued", () => {
    vi.useFakeTimers();
    swrData.current = { invoices: [issuedInvoice()] };
    render(<InvoicesPage />);

    act(() => { vi.advanceTimersByTime(90000); });
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("<InvoicesPage> — Pay Now is gone", () => {
  it("an unpaid row offers no Pay Now button and no retry pill", () => {
    swrData.current = { invoices: [unpaidInvoice()] };
    render(<InvoicesPage />);

    expect(screen.queryByRole("button", { name: /pay now/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/pay now/i)).not.toBeInTheDocument();
    expect(screen.queryByText(RETRY_PILL)).not.toBeInTheDocument();
  });

  it("clicking every button on the page never calls the deleted /pay route", async () => {
    apiPost.mockResolvedValue({ ok: true, data: { recovered: 0, failed: 0, total: 0 } });
    swrData.current = { invoices: [issuedInvoice(), failedInvoice(), unpaidInvoice()] };
    render(<InvoicesPage />);

    for (const btn of screen.getAllByRole("button")) {
      await userEvent.click(btn);
    }

    const payPattern = /\/api\/v1\/user\/invoices\/[^/]+\/pay/;
    const urls = [
      ...vi.mocked(fetch).mock.calls.map((c) => String(c[0])),
      ...apiPost.mock.calls.map((c) => String(c[0])),
    ];
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => payPattern.test(u))).toBe(false);
  });

  it("the page source references neither the /pay route nor the Razorpay checkout (comments stripped)", () => {
    const raw = readFileSync(path.join(process.cwd(), "app/dashboard/invoices/page.tsx"), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/\/pay[`'"]/);
    expect(code).not.toMatch(/RazorpayCheckout/);
    expect(code).not.toMatch(/Pay Now/i);
  });
});

describe("<InvoicesPage> — info banner", () => {
  it("explains automatic issue and the Retry path, without the accounting-system wording", () => {
    swrData.current = { invoices: [issuedInvoice()] };
    render(<InvoicesPage />);

    expect(
      screen.getByText(
        "A GST invoice is issued automatically when your payment completes. If one shows “Generating”, press Retry — or check back in a few minutes and it will appear here."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/synchronized from our accounting system/i)).not.toBeInTheDocument();
  });
});
