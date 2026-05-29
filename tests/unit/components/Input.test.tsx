/**
 * Component tests for <Input> at `@/components/Input` (rescan-4 M14).
 * Pins the label + helperText + error rendering (with error winning the
 * mutual-exclusion fork), the autocomplete inference (email/password/
 * tel + the new-password vs current-password heuristic), the icon/
 * rightIcon padding classes, and `forwardRef` to the underlying input.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import Input from "@/components/Input";

describe("<Input> (custom)", () => {
  it("renders the input with placeholder + label when provided", () => {
    render(<Input label="Email" placeholder="you@example.com" />);
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
  });

  it("error message takes precedence over helperText (helperText hidden when error is set)", () => {
    render(
      <Input
        label="X"
        helperText="this is the helper"
        error="this is the error"
      />
    );
    expect(screen.getByText("this is the error")).toBeInTheDocument();
    expect(screen.queryByText("this is the helper")).not.toBeInTheDocument();
  });

  it("helperText shows when no error is set", () => {
    render(<Input label="X" helperText="enter your value" />);
    expect(screen.getByText("enter your value")).toBeInTheDocument();
  });

  it("error styling adds the red border on the input itself", () => {
    render(<Input error="bad" placeholder="ph" />);
    const input = screen.getByPlaceholderText("ph");
    expect(input.className).toMatch(/border-red-300/);
  });

  it("forwards ref to the underlying input element", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} placeholder="x" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("autocomplete inference: type=email → email", () => {
    render(<Input type="email" placeholder="ph" />);
    expect(screen.getByPlaceholderText("ph")).toHaveAttribute("autocomplete", "email");
  });

  it("autocomplete inference: type=password → current-password (default)", () => {
    render(<Input type="password" placeholder="ph" />);
    expect(screen.getByPlaceholderText("ph")).toHaveAttribute(
      "autocomplete",
      "current-password"
    );
  });

  it("autocomplete inference: type=password with name containing 'confirm' → new-password", () => {
    render(<Input type="password" name="confirmPassword" placeholder="ph" />);
    expect(screen.getByPlaceholderText("ph")).toHaveAttribute(
      "autocomplete",
      "new-password"
    );
  });

  it("autocomplete inference: type=password + name=password + 'create' placeholder → new-password", () => {
    render(
      <Input type="password" name="password" placeholder="Create a strong password" />
    );
    expect(
      screen.getByPlaceholderText("Create a strong password")
    ).toHaveAttribute("autocomplete", "new-password");
  });

  it("autocomplete inference: name=phone → tel", () => {
    render(<Input type="text" name="phone" placeholder="ph" />);
    expect(screen.getByPlaceholderText("ph")).toHaveAttribute("autocomplete", "tel");
  });

  it("explicit autoComplete prop overrides the heuristic", () => {
    render(
      <Input type="password" name="password" autoComplete="off" placeholder="ph" />
    );
    expect(screen.getByPlaceholderText("ph")).toHaveAttribute("autocomplete", "off");
  });

  it("icon prop adds pl-10 padding to the input", () => {
    render(<Input icon={<span>i</span>} placeholder="ph" />);
    expect(screen.getByPlaceholderText("ph").className).toMatch(/pl-10/);
  });

  it("typing into the input updates its value", async () => {
    const user = userEvent.setup();
    render(<Input placeholder="ph" />);
    const input = screen.getByPlaceholderText("ph") as HTMLInputElement;
    await user.type(input, "hello");
    expect(input.value).toBe("hello");
  });
});
