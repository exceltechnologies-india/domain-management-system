/**
 * Component tests for the customer invoices panel (/dashboard/invoices).
 *
 * REGRESSION SUITE (2026-09-02). Every action in this table used to be gated
 * on `invoice.invoice_id`, which only ever holds a ZOHO invoice id. A
 * primary-engine (own GST engine) invoice has no Zoho id at all, so a fully
 * paid customer with a valid `TI/YYYY-YY/NNNNN` tax invoice saw:
 *   - no View button
 *   - no Download button
 *   - an amber "we're finalising the accounting invoice" retry pill, which on
 *     click ran the Zoho self-heal (the double-billing path)
 *   - an empty React key (`key=""`) shared by every primary row
 *
 * These tests pin the provider-aware behaviour that replaced it. The API-side
 * half of the same fix is covered by tests/unit/app/api/user/invoices/route.test.ts.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

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
// The page renders `<razorpay.Frame />`, so the hook mock must supply Frame
// as well as open — returning only `open` makes the element type undefined.
vi.mock("@/components/RazorpayCheckoutFrame", () => ({
  useRazorpayCheckout: () => ({ open: vi.fn(), Frame: () => null }),
}));

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { post: apiPost } }));
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));
vi.mock("@/lib/logout", () => ({ performLogout: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/toast", () => ({ showSuccessToast: vi.fn(), showErrorToast: vi.fn() }));
vi.mock("@/lib/theme-color", () => ({ razorpayThemeColor: "#000000" }));

import InvoicesPage from "@/app/dashboard/invoices/page";

/** A bill issued by our own GST engine — no Zoho id, addressed by order id. */
function primaryInvoice(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: "",
    invoice_number: "TI/2026-27/00001",
    date: "2026-09-01T10:00:00.000Z",
    due_date: "2026-09-01T10:00:00.000Z",
    created_time: "2026-09-01T10:00:00.000Z",
    total: 999,
    balance: 0,
    status: "paid",
    currency_code: "INR",
    provider: "primary",
    order_id: "ord_primary_1",
    zoho_pending: false,
    ...overrides,
  };
}

/** A bill issued by Zoho — addressed by its Zoho invoice id. */
function zohoInvoice(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: "zoho_inv_1",
    invoice_number: "INV-000042",
    date: "2026-09-01T10:00:00.000Z",
    due_date: "2026-09-01T10:00:00.000Z",
    created_time: "2026-09-01T10:00:00.000Z",
    total: 999,
    balance: 0,
    status: "paid",
    currency_code: "INR",
    provider: "zoho",
    order_id: "ord_zoho_1",
    zoho_pending: false,
    ...overrides,
  };
}

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

describe("<InvoicesPage> — primary-engine invoice (no Zoho id)", () => {
  it("renders the tax-invoice number with View and Download actions available", () => {
    swrData.current = { invoices: [primaryInvoice()] };
    render(<InvoicesPage />);

    expect(screen.getByText("TI/2026-27/00001")).toBeInTheDocument();
    expect(screen.getByTitle("View invoice")).toBeInTheDocument();
    expect(screen.getByTitle("Download PDF")).toBeInTheDocument();
  });

  it("does NOT show the 'finalising the accounting invoice' retry pill for an issued bill", () => {
    swrData.current = { invoices: [primaryInvoice()] };
    render(<InvoicesPage />);

    expect(screen.queryByTitle(/finalising the accounting invoice/i)).not.toBeInTheDocument();
  });

  it("downloads via the orderId-keyed route (the Zoho-keyed one would 403 for a primary bill)", async () => {
    swrData.current = { invoices: [primaryInvoice()] };
    render(<InvoicesPage />);

    await userEvent.click(screen.getByTitle("Download PDF"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/v1/orders/ord_primary_1/invoice");
    });
  });

  it("opens the viewer with ?src=order so the viewer fetches the right endpoint", async () => {
    swrData.current = { invoices: [primaryInvoice()] };
    render(<InvoicesPage />);

    await userEvent.click(screen.getByTitle("View invoice"));

    expect(push).toHaveBeenCalledWith("/dashboard/invoices/ord_primary_1/view?src=order");
  });

  it("renders multiple primary invoices as distinct rows (empty React keys used to collide)", () => {
    swrData.current = {
      invoices: [
        primaryInvoice({ invoice_number: "TI/2026-27/00001", order_id: "ord_1" }),
        primaryInvoice({ invoice_number: "TI/2026-27/00002", order_id: "ord_2" }),
      ],
    };
    render(<InvoicesPage />);

    expect(screen.getByText("TI/2026-27/00001")).toBeInTheDocument();
    expect(screen.getByText("TI/2026-27/00002")).toBeInTheDocument();
    expect(screen.getAllByTitle("Download PDF")).toHaveLength(2);
  });
});

describe("<InvoicesPage> — Zoho invoice (unchanged behaviour)", () => {
  it("still downloads through the Zoho-keyed route", async () => {
    swrData.current = { invoices: [zohoInvoice()] };
    render(<InvoicesPage />);

    await userEvent.click(screen.getByTitle("Download PDF"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/v1/user/invoices/zoho_inv_1/pdf");
    });
  });

  it("still opens the viewer without the ?src=order hint", async () => {
    swrData.current = { invoices: [zohoInvoice()] };
    render(<InvoicesPage />);

    await userEvent.click(screen.getByTitle("View invoice"));

    expect(push).toHaveBeenCalledWith("/dashboard/invoices/zoho_inv_1/view");
  });
});

describe("<InvoicesPage> — genuinely un-issued invoice", () => {
  const stuck = () =>
    zohoInvoice({ invoice_id: "", provider: "zoho", zoho_pending: true, order_id: "ord_stuck" });

  it("shows the retry pill and no View/Download when the invoice really is still generating", () => {
    swrData.current = { invoices: [stuck()] };
    render(<InvoicesPage />);

    expect(screen.getByTitle(/finalising the accounting invoice/i)).toBeInTheDocument();
    expect(screen.queryByTitle("Download PDF")).not.toBeInTheDocument();
    expect(screen.queryByTitle("View invoice")).not.toBeInTheDocument();
  });
});
