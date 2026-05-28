/**
 * Component tests for <EmptyState> (rescan-4 M14).
 * Pins the icon + title + description render, the optional action button
 * (rendered only when supplied; click fires onClick), and the className
 * passthrough on the outer wrapper.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Inbox } from "lucide-react";
import EmptyState from "@/components/EmptyState";

describe("<EmptyState>", () => {
  it("renders the title + description", () => {
    render(<EmptyState icon={Inbox} title="No invoices" description="Nothing has been issued yet." />);
    expect(screen.getByRole("heading", { name: /no invoices/i })).toBeInTheDocument();
    expect(screen.getByText(/nothing has been issued yet/i)).toBeInTheDocument();
  });

  it("hides the action button when no `action` prop is supplied", () => {
    render(<EmptyState icon={Inbox} title="Empty" description="…" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the action button with the supplied label and fires onClick", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <EmptyState
        icon={Inbox}
        title="Empty"
        description="…"
        action={{ label: "Add one", onClick }}
      />
    );
    const btn = screen.getByRole("button", { name: /add one/i });
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("passes the className through to the wrapper", () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="Empty" description="…" className="my-custom-cls" />
    );
    expect((container.firstChild as HTMLElement).className).toContain("my-custom-cls");
  });
});
