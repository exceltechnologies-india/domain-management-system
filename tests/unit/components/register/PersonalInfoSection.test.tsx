/**
 * Component tests for <PersonalInfoSection> (rescan-4 M14).
 * Pins the input set (first/last name, email, company, phone), the
 * type=email and type=tel attributes on the email and phone inputs, the
 * non-editable Indian country code display + the hidden phoneCc=+91
 * field used in the form payload, and the onChange wiring.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import PersonalInfoSection from "@/components/register/PersonalInfoSection";
import type { RegisterFormData } from "@/components/register/types";

const BASE_DATA: RegisterFormData = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  password: "",
  confirmPassword: "",
  phone: "9999911111",
  phoneCc: "+91",
  companyName: "Analytical Engine Co",
  address: { line1: "", city: "", state: "", country: "", zipcode: "" },
};

describe("<PersonalInfoSection>", () => {
  it("renders all 5 visible fields with the parent's data populated", () => {
    render(<PersonalInfoSection formData={BASE_DATA} onChange={vi.fn()} />);
    expect((screen.getByPlaceholderText(/first name/i) as HTMLInputElement).value).toBe("Ada");
    expect((screen.getByPlaceholderText(/last name/i) as HTMLInputElement).value).toBe("Lovelace");
    expect((screen.getByPlaceholderText(/email address/i) as HTMLInputElement).value).toBe("ada@example.test");
    expect((screen.getByPlaceholderText(/company name/i) as HTMLInputElement).value).toBe("Analytical Engine Co");
    expect((screen.getByPlaceholderText(/phone number/i) as HTMLInputElement).value).toBe("9999911111");
  });

  it("email input has type=email; phone input has type=tel", () => {
    render(<PersonalInfoSection formData={BASE_DATA} onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText(/email address/i)).toHaveAttribute("type", "email");
    expect(screen.getByPlaceholderText(/phone number/i)).toHaveAttribute("type", "tel");
  });

  it("renders the fixed Indian country-code display + the hidden phoneCc=+91 input", () => {
    const { container } = render(
      <PersonalInfoSection formData={BASE_DATA} onChange={vi.fn()} />
    );
    expect(screen.getByText(/\+91 \(India\)/i)).toBeInTheDocument();
    const hidden = container.querySelector('input[type="hidden"][name="phoneCc"]') as HTMLInputElement;
    expect(hidden).not.toBeNull();
    expect(hidden.value).toBe("+91");
  });

  it("typing fires onChange with the right field name", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PersonalInfoSection
        formData={{ ...BASE_DATA, firstName: "" }}
        onChange={onChange}
      />
    );
    await user.type(screen.getByPlaceholderText(/first name/i), "X");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].target.name).toBe("firstName");
  });
});
