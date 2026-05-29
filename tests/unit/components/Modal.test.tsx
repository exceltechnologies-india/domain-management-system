/**
 * Component tests for <Modal> (rescan-4 M14).
 * Pins the isOpen visibility gate, the title + children render, the
 * size→width-class map, the close-button + overlay-click both firing
 * onClose, and the `closeOnOverlayClick=false` opt-out.
 *
 * Note: AnimatePresence keeps exit-animating nodes in the DOM under
 * jsdom, so tests use fresh mounts via `unmount()` rather than
 * `rerender(isOpen=false)` to assert disappearance.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Modal from "@/components/Modal";

function renderModal(overrides: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <Modal isOpen onClose={onClose} title="Confirm" {...overrides}>
      <p>Modal body</p>
    </Modal>
  );
  return { ...utils, onClose };
}

describe("<Modal>", () => {
  it("renders nothing when isOpen=false", () => {
    render(
      <Modal isOpen={false} onClose={vi.fn()} title="Hidden">
        <p>nope</p>
      </Modal>
    );
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("nope")).not.toBeInTheDocument();
  });

  it("renders the title (h3) + children when isOpen=true", () => {
    renderModal();
    const heading = screen.getByRole("heading", { name: "Confirm" });
    expect(heading.tagName).toBe("H3");
    expect(screen.getByText("Modal body")).toBeInTheDocument();
  });

  it("clicking the close (X) button fires onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    // The X-icon button is the only button rendered.
    const closeBtn = screen.getByRole("button");
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the overlay fires onClose by default", async () => {
    const user = userEvent.setup();
    const { container, onClose } = renderModal();
    // The first motion.div under the modal root is the bg-gray-500 overlay.
    const overlay = container.querySelector(".bg-gray-500.bg-opacity-75")!;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it("closeOnOverlayClick=false suppresses the overlay-click callback", async () => {
    const user = userEvent.setup();
    const { container, onClose } = renderModal({ closeOnOverlayClick: false });
    const overlay = container.querySelector(".bg-gray-500.bg-opacity-75")!;
    await user.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("size prop maps to the max-width class on the panel", () => {
    const { container, unmount } = renderModal({ size: "sm" });
    expect(container.querySelector(".max-w-sm")).not.toBeNull();
    unmount();

    const { container: c2, unmount: u2 } = renderModal({ size: "lg" });
    expect(c2.querySelector(".max-w-2xl")).not.toBeNull();
    u2();

    const { container: c3 } = renderModal({ size: "xl" });
    expect(c3.querySelector(".max-w-4xl")).not.toBeNull();
  });
});
