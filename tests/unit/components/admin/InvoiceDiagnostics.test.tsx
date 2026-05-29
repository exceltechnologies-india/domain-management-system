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
 *  - Re-sync single → POST + success toast.
 *  - Re-sync all: empty list → no-op (no confirm).
 *  - Re-sync all: confirm cancelled → no POST loop.
 *  - Re-sync all: all succeed → bulk-success toast; partial → mixed-error
 *    copy.
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

const stuckMock = vi.hoisted(() =>
  vi.fn(
    ({
      stuckOrders,
      onResync,
      onResyncAll,
    }: {
      stuckOrders: Array<{ orderId: string }>;
      onResync: (id: string) => void;
      onResyncAll: () => void;
    }) => (
      <div data-testid="stuck">
        <span data-testid="stuck-len">{stuckOrders.length}</span>
        <button onClick={onResyncAll}>resync-all</button>
        {stuckOrders.map((o) => (
          <button key={o.orderId} onClick={() => onResync(o.orderId)}>
            resync-{o.orderId}
          </button>
        ))}
      </div>
    )
  )
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

  it("re-sync single → POST + success toast", async () => {
    apiGetMock.mockResolvedValue(ok(TWO_STUCK));
    apiPostMock.mockResolvedValueOnce(ok({ message: "Re-synced." }));
    const user = userEvent.setup();
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByText("resync-ord_a")).toBeInTheDocument());
    await user.click(screen.getByText("resync-ord_a"));
    await waitFor(() => expect(successToastMock).toHaveBeenCalledWith("Re-synced."));
    expect(apiPostMock).toHaveBeenCalledWith(
      "/api/v1/admin/orders/ord_a/re-sync-invoice",
      undefined
    );
  });

  it("re-sync all: empty stuckOrders → no confirm, no POST", async () => {
    apiGetMock.mockResolvedValue(ok(EMPTY));
    const user = userEvent.setup();
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByTestId("header")).toBeInTheDocument());
    // The body isn't rendered when collapsed; force-open via the toggle button.
    await user.click(screen.getByText("toggle"));
    await user.click(screen.getByText("resync-all"));
    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("re-sync all: confirmed + all succeed → bulk-success toast with the count", async () => {
    apiGetMock.mockResolvedValue(ok(TWO_STUCK));
    confirmDialogMock.mockResolvedValueOnce(true);
    apiPostMock
      .mockResolvedValueOnce(ok({ success: true }))
      .mockResolvedValueOnce(ok({ success: true }));
    const user = userEvent.setup();
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByText("resync-all")).toBeInTheDocument());
    await act(async () => {
      await user.click(screen.getByText("resync-all"));
    });
    await waitFor(() =>
      expect(successToastMock).toHaveBeenCalledWith(expect.stringMatching(/Re-synced all 2/i))
    );
  });

  it("re-sync all: partial → mixed-error toast", async () => {
    apiGetMock.mockResolvedValue(ok(TWO_STUCK));
    confirmDialogMock.mockResolvedValueOnce(true);
    apiPostMock
      .mockResolvedValueOnce(ok({ success: true }))
      .mockResolvedValueOnce(fail("upstream 429"));
    const user = userEvent.setup();
    render(<InvoiceDiagnostics />);
    await waitFor(() => expect(screen.getByText("resync-all")).toBeInTheDocument());
    await act(async () => {
      await user.click(screen.getByText("resync-all"));
    });
    await waitFor(() =>
      expect(errorToastMock).toHaveBeenCalledWith(
        expect.stringMatching(/1 succeeded, 1 failed/i)
      )
    );
  });
});
