/**
 * Component tests for <EnhancedToast> + <ToastContainer> (rescan-4 M14).
 * Pins the title + optional-message render, the per-type icon + colour
 * variants, the close-button calling onClose with the toast id after
 * the 300ms exit animation, the duration-based auto-dismiss, and the
 * ToastContainer mapping its `toasts` array to children.
 *
 * Note: AnimatePresence keeps the exit-animating node in the DOM under
 * jsdom — tests assert `onClose(id)` was called rather than visual
 * removal. Fake timers used for duration + the 300ms exit delay.
 */
import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import EnhancedToast, { ToastContainer, type ToastProps } from "@/components/EnhancedToast";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function renderToast(overrides: Partial<ToastProps> = {}) {
  const onClose = vi.fn();
  const props: ToastProps = {
    id: "t1",
    type: "success",
    title: "Saved",
    onClose,
    ...overrides,
  };
  const utils = render(<EnhancedToast {...props} />);
  return { ...utils, onClose };
}

describe("<EnhancedToast>", () => {
  it("renders the title and (optional) message", () => {
    renderToast({ title: "All good", message: "Everything saved" });
    expect(screen.getByText("All good")).toBeInTheDocument();
    expect(screen.getByText("Everything saved")).toBeInTheDocument();
  });

  it("type='success' uses the green colour stripe + green icon class", () => {
    const { container } = renderToast({ type: "success" });
    expect(container.querySelector(".text-green-600")).not.toBeNull();
    expect(container.querySelector(".bg-green-50")).not.toBeNull();
  });

  it("type='error' uses the red colour stripe + red icon class", () => {
    const { container } = renderToast({ type: "error" });
    expect(container.querySelector(".text-red-600")).not.toBeNull();
    expect(container.querySelector(".bg-red-50")).not.toBeNull();
  });

  it("type='warning' uses the yellow palette; type='info' uses the blue palette", () => {
    const { container, unmount } = renderToast({ type: "warning" });
    expect(container.querySelector(".bg-yellow-50")).not.toBeNull();
    unmount();
    const { container: c2 } = renderToast({ type: "info" });
    expect(c2.querySelector(".bg-blue-50")).not.toBeNull();
  });

  it("clicking the close (X) button calls onClose(id) after the 300ms exit", () => {
    const { onClose } = renderToast({ id: "abc" });
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onClose).toHaveBeenCalledWith("abc");
  });

  it("auto-dismisses after `duration` ms (default 5000) + the 300ms exit", () => {
    const { onClose } = renderToast({ id: "d1", duration: 1000 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onClose).toHaveBeenCalledWith("d1");
  });

  it("duration=0 disables the auto-dismiss timer", () => {
    const { onClose } = renderToast({ duration: 0 });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("<ToastContainer>", () => {
  it("renders one EnhancedToast per item in the toasts array", () => {
    const onClose = vi.fn();
    render(
      <ToastContainer
        onClose={onClose}
        toasts={[
          { id: "a", type: "success", title: "First", onClose },
          { id: "b", type: "error", title: "Second", onClose },
        ]}
      />
    );
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });
});
