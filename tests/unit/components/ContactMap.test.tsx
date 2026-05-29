/**
 * Component tests for <ContactMap> (rescan-4 M14).
 * Pins the static copy + the iframe src construction (company coords
 * embedded in the bbox + marker query params) and the directions link.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ContactMap from "@/components/ContactMap";

describe("<ContactMap>", () => {
  it("renders the 'Find Us' heading + address copy", () => {
    render(<ContactMap />);
    expect(screen.getByRole("heading", { name: /find us/i })).toBeInTheDocument();
    expect(screen.getByText(/Anutech Digital Private Limited/)).toBeInTheDocument();
    expect(screen.getByText(/Rohini, Sector-5/)).toBeInTheDocument();
  });

  it("renders an OpenStreetMap iframe whose src embeds the company coords", () => {
    const { container } = render(<ContactMap />);
    const iframe = container.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    const src = iframe.getAttribute("src") || "";
    // Latitude 28.7406 + longitude 77.0884 appear in the bbox and marker
    expect(src).toMatch(/28\.7406/);
    expect(src).toMatch(/77\.0884/);
    expect(src).toContain("openstreetmap.org");
  });

  it("'Get Directions →' is an external link with rel=noopener and target=_blank", () => {
    render(<ContactMap />);
    const link = screen.getByRole("link", { name: /get directions/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("openstreetmap.org/directions"));
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("shows the 'Loading map...' indicator before the iframe load event", () => {
    render(<ContactMap />);
    // Initial render — onLoad hasn't fired yet
    expect(screen.getByText(/loading map/i)).toBeInTheDocument();
  });
});
