/**
 * Component tests for <ExpiryBadge> (rescan-4 M14).
 * Pins the null/invalid-date render-nothing path, the three-tier copy +
 * colour mapping (green > 60d / yellow 15-60d / red ≤ 14d / expired),
 * the "Renew Now" urgency suffix on the red tier, the animate-pulse on
 * 1-14 days remaining (not 0 or >14), and the button-vs-span fork on
 * the `onRenew` prop.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ExpiryBadge from "@/components/dashboard/ExpiryBadge";

// Fix "now" so the day-count math is deterministic.
const NOW = new Date("2025-06-15T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function daysFromNow(d: number): string {
  return new Date(NOW + d * 86_400_000).toISOString();
}

describe("<ExpiryBadge>", () => {
  it("renders nothing when expiryDate is null", () => {
    const { container } = render(<ExpiryBadge expiryDate={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the date string is unparseable (NaN)", () => {
    const { container } = render(<ExpiryBadge expiryDate="not-a-date" />);
    expect(container.firstChild).toBeNull();
  });

  it("green tier: > 60 days renders 'Expires DD MMM YYYY' with the green class set", () => {
    const { container } = render(<ExpiryBadge expiryDate={daysFromNow(90)} />);
    expect(screen.getByText(/expires/i)).toBeInTheDocument();
    expect((container.firstChild as HTMLElement).className).toMatch(/text-green-700/);
  });

  it("yellow tier: 15–60 days renders 'Expires in N days' with the yellow class set", () => {
    const { container } = render(<ExpiryBadge expiryDate={daysFromNow(30)} />);
    expect(screen.getByText(/expires in \d+ days/i)).toBeInTheDocument();
    expect((container.firstChild as HTMLElement).className).toMatch(/text-yellow-700/);
  });

  it("red tier: ≤ 14 days renders 'Expires in N day(s) — Renew Now' with red + animate-pulse", () => {
    const { container } = render(<ExpiryBadge expiryDate={daysFromNow(3)} />);
    expect(screen.getByText(/expires in 3 days — renew now/i)).toBeInTheDocument();
    const el = container.firstChild as HTMLElement;
    expect(el.className).toMatch(/text-red-700/);
    expect(el.className).toMatch(/animate-pulse/);
  });

  it("singular 'day' (not 'days') when exactly 1 day remains", () => {
    render(<ExpiryBadge expiryDate={daysFromNow(1)} />);
    expect(screen.getByText(/expires in 1 day — renew now/i)).toBeInTheDocument();
  });

  it("0 days or already past → 'Expired' with red tier and NO animate-pulse", () => {
    const { container } = render(<ExpiryBadge expiryDate={daysFromNow(-1)} />);
    expect(screen.getByText(/^expired$/i)).toBeInTheDocument();
    const el = container.firstChild as HTMLElement;
    expect(el.className).toMatch(/text-red-700/);
    expect(el.className).not.toMatch(/animate-pulse/);
  });

  it("renders as a <button> firing onRenew when the callback is supplied", () => {
    // user-event under fake timers tends to hang in this codebase; fireEvent.click
    // is synchronous and avoids the issue while exercising the same handler.
    const onRenew = vi.fn();
    render(<ExpiryBadge expiryDate={daysFromNow(7)} onRenew={onRenew} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onRenew).toHaveBeenCalledTimes(1);
  });

  it("renders as a non-interactive <span> when onRenew is omitted (no button role)", () => {
    render(<ExpiryBadge expiryDate={daysFromNow(30)} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
