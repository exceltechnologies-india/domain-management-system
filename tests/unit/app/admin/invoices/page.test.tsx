/**
 * Component tests for the admin invoices panel (/admin/invoices).
 *
 * REGRESSION SUITE (2026-09-03, Phase 1c audit). This page was a pure
 * passthrough to Zoho Books: it fetched `/api/admin/invoices` (which called
 * `zohoService.getAllInvoices`) and keyed every action on `invoice_id`, a
 * field that only ever holds a ZOHO id. A primary-engine tax invoice exists
 * ONLY in our own database — Zoho never sees it — so the admin could not list,
 * view or download a bill the customer legally holds.
 *
 * These tests pin the two-source behaviour that replaced it:
 *   - a source tab switches the list between Zoho Books and the GST engine
 *   - the two tabs are independently paginated and independently cached
 *     (page 1 of one must never be served from the other's cache slot)
 *   - primary rows route their View/Download to the orderId-keyed route
 *   - the Zoho-only diagnostics panel is hidden on the GST tab
 *
 * The API-side half of the same fix is covered by
 * tests/unit/app/api/admin/invoices/route.test.ts.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { role: "admin", name: "Admin User", email: "admin@x.test" } },
    status: "authenticated",
  }),
}));

vi.mock("@/components/admin/AdminLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/skeletons/PageSkeletons", () => ({
  AdminLayoutSkeleton: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AdminGenericPageSkeleton: () => <div>loading</div>,
}));
vi.mock("@/components/dashboard/RefreshButton", () => ({
  default: ({ onClick }: { onClick: () => void }) => (
    <button type="button" onClick={onClick}>Refresh</button>
  ),
}));
vi.mock("@/components/admin/InvoiceDiagnostics", () => ({
  default: () => <div data-testid="invoice-diagnostics">diagnostics</div>,
}));

// Minimal table stand-in: renders each row's cells through the real column
// renderers, so the assertions below exercise the page's own render logic
// rather than the shared table component's.
vi.mock("@/components/admin/AdminDataTable", () => ({
  default: ({
    columns,
    data,
  }: {
    columns: { key: string; label: string; render?: (v: unknown, row: unknown, i: number) => React.ReactNode }[];
    data: Record<string, unknown>[];
  }) => (
    <table>
      <tbody>
        {data.map((row, i) => (
          <tr key={String(row.invoice_number)} data-testid="invoice-row">
            {columns.map((col) => (
              <td key={col.key}>
                {col.render ? col.render(row[col.key], row, i) : String(row[col.key] ?? "")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { get: apiGet } }));
vi.mock("@/lib/logout", () => ({ performLogout: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/toast", () => ({ showSuccessToast: vi.fn(), showErrorToast: vi.fn() }));
vi.mock("@/lib/dateUtils", () => ({ formatIndianDateTime: (v: string) => String(v) }));

import AdminInvoicesPage from "@/app/admin/invoices/page";

/** A bill issued by our own GST engine — no Zoho id, addressed by order id. */
function primaryRow(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: "",
    invoice_number: "TI/2026-27/00001",
    customer_name: "Alice Anderson",
    email: "alice@example.com",
    date: "2026-09-01T10:00:00.000Z",
    due_date: "2026-09-01T10:00:00.000Z",
    created_time: "2026-09-01T10:00:00.000Z",
    total: 1180,
    balance: 0,
    status: "paid",
    currency_code: "INR",
    provider: "primary",
    order_id: "ORD-1",
    ...overrides,
  };
}

function zohoRow(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: "zoho-abc",
    invoice_number: "INV-000123",
    customer_name: "Bob Brown",
    date: "2026-08-01T10:00:00.000Z",
    due_date: "2026-08-01T10:00:00.000Z",
    created_time: "2026-08-01T10:00:00.000Z",
    total: 999,
    balance: 0,
    status: "paid",
    currency_code: "INR",
    provider: "zoho",
    ...overrides,
  };
}

/** Wires apiClient.get to answer per `source` query param. */
function respondBySource(bySource: Record<string, unknown[]>, hasMore = false) {
  apiGet.mockImplementation((url: string) => {
    const src = /source=(\w+)/.exec(url)?.[1] ?? "zoho";
    return Promise.resolve({
      ok: true,
      data: {
        invoices: bySource[src] ?? [],
        page_context: { has_more_page: hasMore },
      },
    });
  });
}

/** The URLs apiClient.get was called with, in order. */
const calledUrls = () => apiGet.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  push.mockReset();
  apiGet.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

describe("Default tab (Zoho) — existing behaviour preserved", () => {
  it("loads the Zoho source on mount", async () => {
    respondBySource({ zoho: [zohoRow()] });
    render(<AdminInvoicesPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(calledUrls()[0]).toContain("source=zoho");
    expect(await screen.findByText("INV-000123")).toBeTruthy();
  });

  it("shows the Zoho-only diagnostics panel", async () => {
    respondBySource({ zoho: [zohoRow()] });
    render(<AdminInvoicesPage />);
    expect(await screen.findByTestId("invoice-diagnostics")).toBeTruthy();
  });

  it("a Zoho row keeps the zohoInvoiceId-keyed view route (no ?src=order)", async () => {
    respondBySource({ zoho: [zohoRow()] });
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");
    await userEvent.click(within(row).getByTitle("View Invoice"));
    expect(push).toHaveBeenCalledWith("/admin/invoices/zoho-abc/view");
  });

  it("a Zoho row downloads from the zohoInvoiceId-keyed PDF route", async () => {
    respondBySource({ zoho: [zohoRow()] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");
    await userEvent.click(within(row).getByTitle("Download PDF"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/invoices/zoho-abc/pdf");
  });
});

describe("GST engine tab — the invoices Zoho can't see", () => {
  it("**switching to the GST tab fetches source=primary and lists the TI/... invoice**", async () => {
    respondBySource({ zoho: [zohoRow()], primary: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByText("INV-000123");

    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));

    expect(await screen.findByText("TI/2026-27/00001")).toBeTruthy();
    expect(calledUrls().some((u) => u.includes("source=primary"))).toBe(true);
  });

  it("**a primary row's View goes to the orderId-keyed route with ?src=order**", async () => {
    respondBySource({ zoho: [], primary: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    const row = await screen.findByTestId("invoice-row");

    await userEvent.click(within(row).getByTitle("View Invoice"));
    // Not `/admin/invoices//view` — the empty invoice_id used to produce that.
    expect(push).toHaveBeenCalledWith("/admin/invoices/ORD-1/view?src=order");
  });

  it("**a primary row downloads from the orderId-keyed admin route**, not the Zoho PDF route which 403s for it", async () => {
    respondBySource({ zoho: [], primary: [primaryRow()] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminInvoicesPage />);
    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    const row = await screen.findByTestId("invoice-row");

    await userEvent.click(within(row).getByTitle("Download PDF"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/orders/ORD-1/invoice");
  });

  it("badges the row so an operator can tell the two number series apart", async () => {
    respondBySource({ zoho: [], primary: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    const row = await screen.findByTestId("invoice-row");
    expect(within(row).getByText("GST")).toBeTruthy();
  });

  it("**hides the Zoho-only diagnostics panel** — primary invoices are excluded from its stuck-order queries, so it would be misleading here", async () => {
    respondBySource({ zoho: [zohoRow()], primary: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByTestId("invoice-diagnostics");

    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    await waitFor(() =>
      expect(screen.queryByTestId("invoice-diagnostics")).toBeNull()
    );
  });

  it("two primary invoices render as two distinct rows (no shared empty key)", async () => {
    respondBySource({
      zoho: [],
      primary: [
        primaryRow({ invoice_number: "TI/2026-27/00001", order_id: "ORD-1" }),
        primaryRow({ invoice_number: "TI/2026-27/00002", order_id: "ORD-2" }),
      ],
    });
    render(<AdminInvoicesPage />);
    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("invoice-row")).toHaveLength(2)
    );
  });
});

describe("Per-source cache isolation", () => {
  it("**the two tabs never serve each other's cached page** — a shared numeric key would show Zoho rows under the GST tab", async () => {
    respondBySource({ zoho: [zohoRow()], primary: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByText("INV-000123");

    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    await screen.findByText("TI/2026-27/00001");
    expect(screen.queryByText("INV-000123")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Zoho Books" }));
    await screen.findByText("INV-000123");
    expect(screen.queryByText("TI/2026-27/00001")).toBeNull();
  });

  it("switching back to a visited tab is served from cache — no refetch", async () => {
    respondBySource({ zoho: [zohoRow()], primary: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByText("INV-000123");

    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    await screen.findByText("TI/2026-27/00001");
    const afterFirstSwitch = apiGet.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Zoho Books" }));
    await screen.findByText("INV-000123");
    expect(apiGet.mock.calls.length).toBe(afterFirstSwitch);
  });

  it("clicking the active tab is a no-op (no duplicate fetch)", async () => {
    respondBySource({ zoho: [zohoRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByText("INV-000123");
    const before = apiGet.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Zoho Books" }));
    expect(apiGet.mock.calls.length).toBe(before);
  });

  it("Refresh re-fetches the ACTIVE source, not the default one", async () => {
    respondBySource({ zoho: [zohoRow()], primary: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByText("INV-000123");
    await userEvent.click(screen.getByRole("button", { name: "GST engine" }));
    await screen.findByText("TI/2026-27/00001");

    apiGet.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(calledUrls().every((u) => u.includes("source=primary"))).toBe(true);
  });
});
