/**
 * Component tests for the admin invoices panel (/admin/invoices).
 *
 * HISTORY. On 2026-09-03 (Phase 1c audit) this page gained two source tabs,
 * "Zoho Books | GST engine", because a primary-engine tax invoice existed only
 * in our own database and the Zoho-backed list could not show it. On
 * 2026-09-24 Zoho Books was removed from the app by owner decision, so there
 * is ONE list again — our own collection — and every row is addressed by
 * `order_id`:
 *   - the list is fetched with no `source` param and cached per page
 *   - View goes to /admin/invoices/<order_id>/view (no ?src=order)
 *   - Download goes to /api/v1/admin/orders/<order_id>/invoice
 *   - rows issued by Zoho before the removal carry a "Historical" badge
 *   - the diagnostics panel is always shown
 *
 * The API-side half is covered by tests/unit/app/api/admin/invoices/route.test.ts.
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
    currentPage,
    onPageChange,
  }: {
    columns: { key: string; label: string; render?: (v: unknown, row: unknown, i: number) => React.ReactNode }[];
    data: Record<string, unknown>[];
    currentPage: number;
    onPageChange: (p: number) => void;
  }) => (
    <>
    <button type="button" onClick={() => onPageChange(currentPage + 1)}>Next page</button>
    <button type="button" onClick={() => onPageChange(currentPage - 1)}>Previous page</button>
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
    </>
  ),
}));

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { get: apiGet } }));
vi.mock("@/lib/logout", () => ({ performLogout: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/toast", () => ({ showSuccessToast: vi.fn(), showErrorToast: vi.fn() }));
vi.mock("@/lib/dateUtils", () => ({ formatIndianDateTime: (v: string) => String(v) }));

import AdminInvoicesPage from "@/app/admin/invoices/page";


/** A bill issued by our own GST engine, addressed by order id. */
function primaryRow(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: "ORD-1",
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

/** A bill Zoho Books issued before it was removed — still an order in our DB. */
function historicalZohoRow(overrides: Record<string, unknown> = {}) {
  return {
    invoice_id: "ORD-OLD",
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
    order_id: "ORD-OLD",
    ...overrides,
  };
}

/** Wires apiClient.get to answer per `page` query param. */
function respondByPage(byPage: Record<number, unknown[]>, lastPage = 1) {
  apiGet.mockImplementation((url: string) => {
    const pg = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
    return Promise.resolve({
      ok: true,
      data: {
        invoices: byPage[pg] ?? [],
        page_context: { has_more_page: pg < lastPage, total: 99 },
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

describe("one list, from our own collection", () => {
  it("fetches page 1 with no source param and lists both primary and historical rows", async () => {
    respondByPage({ 1: [primaryRow(), historicalZohoRow()] });
    render(<AdminInvoicesPage />);
    expect(await screen.findByText("TI/2026-27/00001")).toBeTruthy();
    expect(screen.getByText("INV-000123")).toBeTruthy();
    expect(calledUrls()[0]).toBe("/api/v1/admin/invoices?page=1&per_page=10");
    expect(calledUrls().some((u) => u.includes("source="))).toBe(false);
  });

  it("offers no source tabs — Zoho Books is gone and there is nothing to switch to", async () => {
    respondByPage({ 1: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByText("TI/2026-27/00001");
    expect(screen.queryByRole("button", { name: "Zoho Books" })).toBeNull();
    expect(screen.queryByRole("button", { name: "GST engine" })).toBeNull();
  });

  it("always shows the diagnostics panel", async () => {
    respondByPage({ 1: [primaryRow()] });
    render(<AdminInvoicesPage />);
    expect(await screen.findByTestId("invoice-diagnostics")).toBeTruthy();
  });

  it("two invoices render as two distinct rows", async () => {
    respondByPage({
      1: [
        primaryRow({ invoice_number: "TI/2026-27/00001", order_id: "ORD-1" }),
        primaryRow({ invoice_number: "TI/2026-27/00002", order_id: "ORD-2" }),
      ],
    });
    render(<AdminInvoicesPage />);
    await waitFor(() => expect(screen.getAllByTestId("invoice-row")).toHaveLength(2));
  });
});

describe("rows are addressed by order_id", () => {
  it("View goes to /admin/invoices/<order_id>/view with no ?src=order", async () => {
    respondByPage({ 1: [primaryRow()] });
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");
    await userEvent.click(within(row).getByTitle("View Invoice"));
    expect(push).toHaveBeenCalledWith("/admin/invoices/ORD-1/view");
  });

  it("Download fetches the orderId-keyed admin route", async () => {
    respondByPage({ 1: [primaryRow()] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");
    await userEvent.click(within(row).getByTitle("Download PDF"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/orders/ORD-1/invoice");
  });

  it("a historical Zoho row also views and downloads by order_id — the removed Zoho-keyed routes are never called", async () => {
    respondByPage({ 1: [historicalZohoRow()] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");

    await userEvent.click(within(row).getByTitle("View Invoice"));
    expect(push).toHaveBeenCalledWith("/admin/invoices/ORD-OLD/view");

    await userEvent.click(within(row).getByTitle("Download PDF"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/admin/orders/ORD-OLD/invoice");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/v1/admin/invoices/"))).toBe(false);
  });

  it("a row with no order_id has View and Download disabled rather than building //view", async () => {
    respondByPage({ 1: [primaryRow({ order_id: undefined })] });
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");
    expect((within(row).getByTitle("View Invoice") as HTMLButtonElement).disabled).toBe(true);
    expect((within(row).getByTitle("Download PDF") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Historical badge", () => {
  it("badges a row Zoho issued before the removal", async () => {
    respondByPage({ 1: [historicalZohoRow()] });
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");
    expect(within(row).getByText("Historical")).toBeTruthy();
  });

  it("does not badge a primary row, and the old GST badge is gone", async () => {
    respondByPage({ 1: [primaryRow()] });
    render(<AdminInvoicesPage />);
    const row = await screen.findByTestId("invoice-row");
    expect(within(row).queryByText("Historical")).toBeNull();
    expect(within(row).queryByText("GST")).toBeNull();
  });
});

describe("per-page cache", () => {
  it("going back to a visited page is served from cache — no refetch", async () => {
    respondByPage({ 1: [primaryRow()], 2: [historicalZohoRow()] }, 2);
    render(<AdminInvoicesPage />);
    await screen.findByText("TI/2026-27/00001");

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("INV-000123");
    expect(screen.queryByText("TI/2026-27/00001")).toBeNull();
    const afterNext = apiGet.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByText("TI/2026-27/00001");
    expect(screen.queryByText("INV-000123")).toBeNull();
    expect(apiGet.mock.calls.length).toBe(afterNext);
    // Each page was fetched exactly once (page 2 by the adjacent prefetch).
    expect(calledUrls().filter((u) => u.includes("page=1&")).length).toBe(1);
    expect(calledUrls().filter((u) => u.includes("page=2&")).length).toBe(1);
  });

  it("Refresh bypasses the cache and re-fetches the current page", async () => {
    respondByPage({ 1: [primaryRow()] });
    render(<AdminInvoicesPage />);
    await screen.findByText("TI/2026-27/00001");

    apiGet.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(calledUrls()).toEqual(["/api/v1/admin/invoices?page=1&per_page=10"]);
  });
});
