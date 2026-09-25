/**
 * Component tests for the admin <InvoiceDiagnostics> (rescan-4 M14).
 * Mocks `apiClient`, `confirmDialog`, and the toast helpers via vi.hoisted.
 * Subcomponents (`DiagnosticsHeader`, `ConflictsTable`, `StuckOrdersTable`)
 * are mocked to keep the focus on the orchestration logic in
 * InvoiceDiagnostics itself.
 *
 * Coverage:
 *  - Initial loading skeleton.
 *  - Empty-issues fetch → starts collapsed (no auto-expand).
 *  - With-issues fetch → auto-expands.
 *  - Clear invoice number: confirm cancelled → no POST.
 *  - Clear invoice number: confirmed → POST + success toast + refetch.
 *  - The paid-without-bill list is read-only: no Re-sync (removed with
 *    DMS's invoice engine, 25 Sep 2026).
 */
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

type Result<T> = { ok: true; data: T } | { ok: false; error: { status: number; message: string } };
const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const fail = (message = "boom", status = 500): Result<never> => ({
  ok: false,
  error: { status, message },
});

const apiGetMock = vi.hoisted(() => vi.fn());
const apiPostMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  apiClient: { get: apiGetMock, post: apiPostMock },
}));

const confirmDialogMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/confirm-dialog", () => ({ confirmDialog: confirmDialogMock }));

const successToastMock = vi.hoisted(() => vi.fn());
const errorToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({
  showSuccessToast: successToastMock,
  showErrorToast: errorToastMock,
  // Other helpers exported from the module — stub away the ones we don't use.
  showAccountDeactivated: vi.fn(),
}));

// Mock the three subcomponents so we can assert on their props.
const headerMock = vi.hoisted(() =>
  vi.fn(
    ({
      hasIssues,
      isOpen,
      onToggle,
      onRefresh,
    }: {
      hasIssues: boolean;
      isOpen: boolean;
      onToggle: () => void;
      onRefresh: () => void;
    }) => (
      <div data-testid="header">
        <span data-testid="hasIssues">{String(hasIssues)}</span>
        <span data-testid="isOpen">{String(isOpen)}</span>
        <button onClick={onToggle}>toggle</button>
        <button onClick={onRefresh}>refresh</button>
      </div>
    )
  )
);
vi.mock("@/components/admin/invoice-diagnostics/DiagnosticsHeader", () => ({
  default: headerMock,
}));

const conflictsMock = vi.hoisted(() =>
  vi.fn(
    ({
      conflicts,
      onClearInvoiceNumber,
    }: {
      conflicts: Array<{ orderId: string }>;
      onClearInvoiceNumber: (id: string) => void;
    }) => (
      <div data-testid="conflicts">
        <span data-testid="conflicts-len">{conflicts.length}</span>
        {conflicts.map((c) => (
          <button key={c.orderId} onClick={() => onClearInvoiceNumber(c.orderId)}>
            clear-{c.orderId}
          </button>
        ))}
      </div>
    )
  )
);
vi.mock("@/components/admin/invoice-diagnostics/ConflictsTable", () => ({
  default: conflictsMock,
}));

// Read-only since 25 Sep 2026 (DMS issues no bills): no Re-sync callbacks.
const stuckMock = vi.hoisted(() =>
  vi.fn(({ stuckOrders, ...rest }: { stuckOrders: Array<{ orderId: string }> } & Record<string, unknown>) => (
    <div data-testid="stuck">
      <span data-testid="stuck-len">{stuckOrders.length}</span>
      <span data-testid="stuck-extra-props">{Object.keys(rest).join(",")}</span>
    </div>
  ))
);
vi.mock("@/components/admin/invoice-diagnostics/StuckOrdersTable", () => ({
  default: stuckMock,
}));

import InvoiceDiagnostics from "@/components/admin/InvoiceDiagnostics";

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  confirmDialogMock.mockReset();
  successToastMock.mockReset();
  errorToastMock.mockReset();
  headerMock.mockClear();
  conflictsMock.mockClear();
  stuckMock.mockClear();
});

const EMPTY = {
  summary: { conflictGroups: 0, stuckOrders: 0 },
  conflicts: [],
  stuckOrders: [],
};

const ONE_CONFLICT = {
  summary: { conflictGroups: 1, stuckOrders: 0 },
  conflicts: [{ orderId: "ord_1" }],
  stuckOrders: [],
};

const TWO_STUCK = {
  summary: { conflictGroups: 0, stuckOrders: 2 },
  conflicts: [],
  stuckOrders: [{ orderId: "ord_a" }, { orderId: "ord_b" }],
};

describe("<InvoiceDiagnostics>", () => {
  it("shows the loading skeleton initially, then mounts the header after fetch resolves", async () => {
    apiGetMock.mockResolvedValueOnce(ok(EMPTY));
    render(<InvoiceDiagnostics />);
    expect(screen.getByText(/checking invoice diagnostics/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("header")).toBeInTheDocument());
  });

  it("empty-issues fetch leaves the panel collapsed (isOpen=false)", async () => {
    apiGetMock.mockResolvedValueOnce(ok(EMPTY));
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByTestId("header")).toBeInTheDocument());
    expect(screen.getByTestId("isOpen").textContent).toBe("false");
    expect(screen.getByTestId("hasIssues").textContent).toBe("false");
    // Body content not rendered when collapsed.
    expect(screen.queryByTestId("conflicts")).not.toBeInTheDocument();
  });

  it("with-issues fetch auto-expands the panel (isOpen=true + body rendered)", async () => {
    apiGetMock.mockResolvedValueOnce(ok(ONE_CONFLICT));
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByTestId("isOpen").textContent).toBe("true"));
    expect(screen.getByTestId("hasIssues").textContent).toBe("true");
    expect(screen.getByTestId("conflicts")).toBeInTheDocument();
    expect(screen.getByTestId("conflicts-len").textContent).toBe("1");
  });

  it("clear-invoice-number: confirmDialog declined → no POST + no toast", async () => {
    apiGetMock.mockResolvedValue(ok(ONE_CONFLICT));
    confirmDialogMock.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByText("clear-ord_1")).toBeInTheDocument());
    await user.click(screen.getByText("clear-ord_1"));
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(successToastMock).not.toHaveBeenCalled();
  });

  it("clear-invoice-number: confirmed → POST + success toast + refetch", async () => {
    apiGetMock.mockResolvedValue(ok(ONE_CONFLICT));
    confirmDialogMock.mockResolvedValueOnce(true);
    apiPostMock.mockResolvedValueOnce(ok({ message: "Cleared." }));
    const user = userEvent.setup();
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByText("clear-ord_1")).toBeInTheDocument());
    await user.click(screen.getByText("clear-ord_1"));
    await waitFor(() => expect(successToastMock).toHaveBeenCalledWith("Cleared."));
    expect(apiPostMock).toHaveBeenCalledWith(
      "/api/v1/admin/orders/ord_1/clear-invoice-number",
      undefined
    );
    // Refetch happens after the POST → apiGet called twice (initial + refetch).
    expect(apiGetMock).toHaveBeenCalledTimes(2);
  });

  it("the all-clear line speaks of bills, and the clear-number confirm is unchanged — Zoho Books is gone", async () => {
    apiGetMock.mockResolvedValue(ok(EMPTY));
    const user = userEvent.setup();
    const { unmount } = render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByTestId("header")).toBeInTheDocument());
    await user.click(screen.getByText("toggle"));
    expect(
      screen.getByText("All invoice numbers are unique and no paid order is waiting for a bill.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/zoho/i)).not.toBeInTheDocument();
    unmount();

    confirmDialogMock.mockResolvedValue(false);
    apiGetMock.mockResolvedValue(ok({ ...ONE_CONFLICT, stuckOrders: TWO_STUCK.stuckOrders }));
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByText("clear-ord_1")).toBeInTheDocument());
    await user.click(screen.getByText("clear-ord_1"));
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    const clearCall = confirmDialogMock.mock.calls[0][0] as { title: string; message: string };
    expect(clearCall.message).toContain("No issued invoice is changed.");
    expect(`${clearCall.title} ${clearCall.message}`).not.toMatch(/zoho/i);
  });

  it("the paid-without-bill list is handed its rows and no re-sync action", async () => {
    apiGetMock.mockResolvedValue(ok(TWO_STUCK));
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByTestId("stuck-len")).toHaveTextContent("2"));
    expect(screen.getByTestId("stuck-extra-props")).toHaveTextContent("");
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
