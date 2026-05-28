/**
 * Component tests for <OutboundIPBadge> (rescan-4 M14).
 * Pins the loading badge on mount, the green single-IP and orange
 * multiple-IPs displays (with the "*" suffix), the two error paths
 * (response success:false + apiClient !ok both surface "IP Error"), and
 * the title-tooltip's primary + all-IPs content.
 *
 * The 30-minute refresh interval isn't asserted — pure clock-driven and
 * not load-bearing.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockApiGet } = vi.hoisted(() => ({ mockApiGet: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ apiClient: { get: mockApiGet } }));

import OutboundIPBadge from "@/components/OutboundIPBadge";

beforeEach(() => {
  mockApiGet.mockReset();
});

describe("<OutboundIPBadge>", () => {
  it("renders the loading badge initially", () => {
    // Hold the promise indefinitely so loading state stays visible
    mockApiGet.mockReturnValue(new Promise(() => {}));
    render(<OutboundIPBadge />);
    expect(screen.getByText(/loading ip/i)).toBeInTheDocument();
  });

  it("shows the primary IP with a green dot when a single IP is returned", async () => {
    mockApiGet.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        message: "ok",
        data: { primaryIP: "34.14.59.128", allIPs: ["34.14.59.128"], timestamp: "2025-01-01T10:00:00Z", services: {} },
      },
    });
    render(<OutboundIPBadge />);
    expect(await screen.findByText("34.14.59.128")).toBeInTheDocument();
    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });

  it("appends a '*' suffix and exposes all IPs via the title tooltip when multiple IPs are returned", async () => {
    mockApiGet.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        message: "ok",
        data: {
          primaryIP: "34.14.59.128",
          allIPs: ["34.14.59.128", "34.14.59.129"],
          timestamp: "2025-01-01T10:00:00Z",
          services: {},
        },
      },
    });
    render(<OutboundIPBadge />);
    expect(await screen.findByText("34.14.59.128")).toBeInTheDocument();
    expect(screen.getByText("*")).toBeInTheDocument();
    // Title tooltip carries the all-IPs list — climb to the Badge root.
    const badge = screen.getByText("34.14.59.128").closest('[title]');
    expect(badge?.getAttribute("title")).toContain("All IPs: 34.14.59.128, 34.14.59.129");
  });

  it("shows the 'IP Error' badge when the response has success:false", async () => {
    mockApiGet.mockResolvedValue({
      ok: true,
      data: { success: false, message: "Provider down" },
    });
    render(<OutboundIPBadge />);
    expect(await screen.findByText(/ip error/i)).toBeInTheDocument();
  });

  it("shows the 'IP Error' badge when apiClient returns !ok", async () => {
    mockApiGet.mockResolvedValue({ ok: false, error: { status: 500, message: "Internal error" } });
    render(<OutboundIPBadge />);
    expect(await screen.findByText(/ip error/i)).toBeInTheDocument();
  });
});
