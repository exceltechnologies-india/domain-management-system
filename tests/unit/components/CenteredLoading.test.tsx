/**
 * Component tests for <CenteredLoading> + <InlineLoader> (rescan-4 M14).
 * Pins the default 'Loading...' + dots, the custom message override, the
 * size→class mapping on the spinner, the `showMessage=false` branch
 * (drops the text), the `fullScreen=true` fixed-overlay wrapper vs the
 * inline min-h-[200px] wrapper. Plus the InlineLoader's size-class map.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import CenteredLoading, { InlineLoader } from "@/components/CenteredLoading";

describe("<CenteredLoading>", () => {
  it("renders the default 'Loading...' copy + dots", () => {
    render(<CenteredLoading fullScreen={false} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(screen.getByText("...")).toBeInTheDocument();
  });

  it("custom message overrides the default", () => {
    render(<CenteredLoading message="Provisioning" fullScreen={false} />);
    expect(screen.getByText(/Provisioning/)).toBeInTheDocument();
  });

  it("showMessage=false omits the message + dots", () => {
    render(<CenteredLoading message="Hidden" showMessage={false} fullScreen={false} />);
    expect(screen.queryByText(/Hidden/)).not.toBeInTheDocument();
    expect(screen.queryByText("...")).not.toBeInTheDocument();
  });

  it("size='xl' applies the h-20 w-20 spinner classes", () => {
    const { container } = render(<CenteredLoading size="xl" fullScreen={false} />);
    expect(container.querySelector(".h-20.w-20")).not.toBeNull();
  });

  it("fullScreen=true wraps in a fixed inset-0 overlay", () => {
    const { container } = render(<CenteredLoading fullScreen />);
    expect(container.querySelector(".fixed.inset-0")).not.toBeNull();
  });

  it("fullScreen=false uses the min-h-[200px] inline wrapper", () => {
    const { container } = render(<CenteredLoading fullScreen={false} />);
    expect(container.querySelector(".fixed.inset-0")).toBeNull();
    expect(container.querySelector(".min-h-\\[200px\\]")).not.toBeNull();
  });
});

describe("<InlineLoader>", () => {
  it("default size='sm' uses h-4 w-4 spinner classes", () => {
    const { container } = render(<InlineLoader />);
    expect(container.querySelector(".h-4.w-4")).not.toBeNull();
  });

  it("size='lg' uses h-6 w-6 spinner classes; className passthrough on the wrapper", () => {
    const { container } = render(<InlineLoader size="lg" className="extra-cls" />);
    expect(container.querySelector(".h-6.w-6")).not.toBeNull();
    expect((container.firstChild as HTMLElement).className).toContain("extra-cls");
  });
});
