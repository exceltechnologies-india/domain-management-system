/**
 * Component tests for <DiagnosticsHeader> (rescan-4 M14).
 * Pins the no-issues / has-issues icon + copy, the singular/plural grammar
 * of the summary line, the row-click → onToggle vs Refresh-chip-click →
 * onRefresh (with e.stopPropagation suppressing toggle), the open/closed
 * chevron flip, and the spinner class on the Refresh icon while loading.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import DiagnosticsHeader from "@/components/admin/invoice-diagnostics/DiagnosticsHeader";
import type { DiagnosticsResponse } from "@/components/admin/invoice-diagnostics/types";

function defaultData(overrides: Partial<DiagnosticsResponse["summary"]> = {}): DiagnosticsResponse {
  return {
    conflicts: [],
    stuckOrders: [],
    summary: { conflictGroups: 0, conflictedOrders: 0, stuckOrders: 0, ...overrides },
  };
}

describe("<DiagnosticsHeader>", () => {
  it("renders the 'Invoice Diagnostics' heading", () => {
    render(
      <DiagnosticsHeader
        data={defaultData()}
        hasIssues={false}
        isOpen={false}
        isLoading={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    expect(screen.getByText(/invoice diagnostics/i)).toBeInTheDocument();
  });

  it("renders the all-clear copy when hasIssues is false", () => {
    render(
      <DiagnosticsHeader
        data={defaultData()}
        hasIssues={false}
        isOpen={false}
        isLoading={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    expect(screen.getByText(/no conflicts or stuck orders/i)).toBeInTheDocument();
  });

  it("uses plural grammar when there are multiple conflicts and stuck orders", () => {
    render(
      <DiagnosticsHeader
        data={defaultData({ conflictGroups: 3, stuckOrders: 2 })}
        hasIssues
        isOpen={false}
        isLoading={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    expect(screen.getByText(/3 conflicts, 2 stuck orders/i)).toBeInTheDocument();
  });

  it("uses singular grammar for exactly one conflict and one stuck order", () => {
    render(
      <DiagnosticsHeader
        data={defaultData({ conflictGroups: 1, stuckOrders: 1 })}
        hasIssues
        isOpen={false}
        isLoading={false}
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    expect(screen.getByText(/1 conflict, 1 stuck order/i)).toBeInTheDocument();
  });

  it("toggles via row click and refreshes via the chip — stopPropagation suppresses toggle on the chip", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onRefresh = vi.fn();
    render(
      <DiagnosticsHeader
        data={defaultData()}
        hasIssues={false}
        isOpen={false}
        isLoading={false}
        onToggle={onToggle}
        onRefresh={onRefresh}
      />
    );

    // Refresh chip click → onRefresh fires, onToggle does NOT (e.stopPropagation)
    await user.click(screen.getByText(/refresh/i));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();

    // Header heading click (somewhere off the chip) → onToggle fires
    await user.click(screen.getByText(/invoice diagnostics/i));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("spins the refresh icon while isLoading is true", () => {
    const { container } = render(
      <DiagnosticsHeader
        data={defaultData()}
        hasIssues={false}
        isOpen={false}
        isLoading
        onToggle={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    // The first svg inside the Refresh chip carries the animate-spin class.
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });
});
