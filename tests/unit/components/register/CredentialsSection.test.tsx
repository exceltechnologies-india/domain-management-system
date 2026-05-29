/**
 * Component tests for <CredentialsSection> (rescan-4 M14).
 * Pins the password + confirm-password inputs (each owns its own
 * show/hide toggle), the type=password ↔ type=text toggle on the eye
 * button, and that the parent's onChange handler receives both fields.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import CredentialsSection from "@/components/register/CredentialsSection";
import type { RegisterFormData } from "@/components/register/types";

const BASE_DATA: RegisterFormData = {
  firstName: "",
  lastName: "",
  email: "",
  password: "secret123",
  confirmPassword: "secret123",
  phone: "",
  phoneCc: "+91",
  companyName: "",
  address: { line1: "", city: "", state: "", country: "", zipcode: "" },
};

describe("<CredentialsSection>", () => {
  it("renders both Password and Confirm password fields as masked by default", () => {
    render(<CredentialsSection formData={BASE_DATA} onChange={vi.fn()} />);
    const pw = screen.getByPlaceholderText("Create a strong password") as HTMLInputElement;
    const confirm = screen.getByPlaceholderText("Confirm your password") as HTMLInputElement;
    expect(pw.type).toBe("password");
    expect(confirm.type).toBe("password");
    expect(pw.value).toBe("secret123");
  });

  it("clicking the password eye toggles type=password → type=text → type=password", async () => {
    const user = userEvent.setup();
    render(<CredentialsSection formData={BASE_DATA} onChange={vi.fn()} />);
    const pw = screen.getByPlaceholderText("Create a strong password") as HTMLInputElement;
    // The first button is the password eye (per source order).
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[0]);
    expect(pw.type).toBe("text");
    await user.click(buttons[0]);
    expect(pw.type).toBe("password");
  });

  it("password and confirm-password eye toggles are independent", async () => {
    const user = userEvent.setup();
    render(<CredentialsSection formData={BASE_DATA} onChange={vi.fn()} />);
    const pw = screen.getByPlaceholderText("Create a strong password") as HTMLInputElement;
    const confirm = screen.getByPlaceholderText("Confirm your password") as HTMLInputElement;
    const [pwEye, confirmEye] = screen.getAllByRole("button");
    await user.click(confirmEye);
    expect(confirm.type).toBe("text");
    expect(pw.type).toBe("password"); // unaffected
    await user.click(pwEye);
    expect(pw.type).toBe("text");
    expect(confirm.type).toBe("text"); // confirm stays visible
  });

  it("typing in either field calls onChange with the right `name`", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CredentialsSection
        formData={{ ...BASE_DATA, password: "", confirmPassword: "" }}
        onChange={onChange}
      />
    );
    await user.type(screen.getByPlaceholderText("Create a strong password"), "a");
    expect(onChange).toHaveBeenCalled();
    const pwEvent = onChange.mock.calls[0][0];
    expect(pwEvent.target.name).toBe("password");

    onChange.mockClear();
    await user.type(screen.getByPlaceholderText("Confirm your password"), "a");
    const confirmEvent = onChange.mock.calls[0][0];
    expect(confirmEvent.target.name).toBe("confirmPassword");
  });
});
