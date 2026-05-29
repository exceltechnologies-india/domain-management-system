/**
 * Component tests for <Textarea> (rescan-4 M14).
 * Pins the label rendering, the error and helperText mutual-exclusion
 * (error takes precedence and adds the red ring class), the ref
 * forwarding, and the props passthrough.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import Textarea from "@/components/Textarea";

describe("<Textarea>", () => {
  it("renders a textarea element", () => {
    render(<Textarea />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("renders the label when provided", () => {
    render(<Textarea label="Notes" />);
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  it("renders helperText below the textarea when no error is set", () => {
    render(<Textarea helperText="Please describe in detail" />);
    expect(screen.getByText(/please describe in detail/i)).toBeInTheDocument();
  });

  it("error takes precedence over helperText (mutual exclusion) and adds the red ring class", () => {
    render(<Textarea error="Required" helperText="Helpful hint" />);
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.queryByText(/helpful hint/i)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox").className).toMatch(/border-red-300/);
  });

  it("forwards the ref to the underlying textarea element", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("passes arbitrary textarea props through (placeholder, rows, name)", () => {
    render(<Textarea placeholder="Tell us more" rows={5} name="comment" />);
    const ta = screen.getByPlaceholderText(/tell us more/i) as HTMLTextAreaElement;
    expect(ta.rows).toBe(5);
    expect(ta.name).toBe("comment");
  });
});
