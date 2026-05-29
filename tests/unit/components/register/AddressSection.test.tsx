/**
 * Component tests for <AddressSection> (rescan-4 M14).
 * The register-form address subform. Pins the field set (line1 +
 * city + state select + country fixed display + hidden country=IN
 * + zipcode), the INDIAN_STATES options in the state select, the
 * Auto-fill button forwarding to onDetectLocation (with the
 * isDetectingLocation disabled + loading branches), and the change
 * wiring for the dotted-path field names.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import AddressSection from "@/components/register/AddressSection";
import type { RegisterFormData } from "@/components/register/types";
import { INDIAN_STATES } from "@/lib/constants";

const BASE_DATA: RegisterFormData = {
  firstName: "",
  lastName: "",
  email: "",
  password: "",
  confirmPassword: "",
  phone: "",
  phoneCc: "+91",
  companyName: "",
  address: {
    line1: "B-9, Sector 5",
    city: "Delhi",
    state: "Delhi",
    country: "IN",
    zipcode: "110085",
  },
};

describe("<AddressSection>", () => {
  it("renders Address Line 1 / City / State / Zip fields populated from formData", () => {
    render(
      <AddressSection
        formData={BASE_DATA}
        onChange={vi.fn()}
        isDetectingLocation={false}
        onDetectLocation={vi.fn()}
      />
    );
    expect((screen.getByPlaceholderText(/street address/i) as HTMLInputElement).value).toBe(
      "B-9, Sector 5"
    );
    expect((screen.getByPlaceholderText(/enter city/i) as HTMLInputElement).value).toBe("Delhi");
    expect((screen.getByPlaceholderText(/enter zip code/i) as HTMLInputElement).value).toBe(
      "110085"
    );
  });

  it("renders the fixed Indian country display + hidden address.country=IN input", () => {
    const { container } = render(
      <AddressSection
        formData={BASE_DATA}
        onChange={vi.fn()}
        isDetectingLocation={false}
        onDetectLocation={vi.fn()}
      />
    );
    expect(screen.getByText(/🇮🇳 India/)).toBeInTheDocument();
    const hidden = container.querySelector(
      'input[type="hidden"][name="address.country"]'
    ) as HTMLInputElement;
    expect(hidden).not.toBeNull();
    expect(hidden.value).toBe("IN");
  });

  it("State select includes every entry from INDIAN_STATES", () => {
    render(
      <AddressSection
        formData={BASE_DATA}
        onChange={vi.fn()}
        isDetectingLocation={false}
        onDetectLocation={vi.fn()}
      />
    );
    const stateSelect = screen.getByRole("combobox") as HTMLSelectElement;
    expect(stateSelect.tagName).toBe("SELECT");
    expect(stateSelect.value).toBe("Delhi");
    const optionValues = Array.from(stateSelect.options).map((o) => o.value);
    for (const state of INDIAN_STATES) {
      expect(optionValues).toContain(state);
    }
  });

  it("Auto-fill button fires onDetectLocation when enabled", async () => {
    const user = userEvent.setup();
    const onDetectLocation = vi.fn();
    render(
      <AddressSection
        formData={BASE_DATA}
        onChange={vi.fn()}
        isDetectingLocation={false}
        onDetectLocation={onDetectLocation}
      />
    );
    await user.click(screen.getByRole("button", { name: /auto-fill/i }));
    expect(onDetectLocation).toHaveBeenCalledTimes(1);
  });

  it("isDetectingLocation=true disables the Auto-fill button and surfaces a loading spinner", () => {
    const { container } = render(
      <AddressSection
        formData={BASE_DATA}
        onChange={vi.fn()}
        isDetectingLocation
        onDetectLocation={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /auto-fill/i })).toBeDisabled();
    // The custom Button's loading state embeds an animate-spin svg.
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("typing in city + selecting state both call onChange with dotted-path names", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AddressSection
        formData={{ ...BASE_DATA, address: { ...BASE_DATA.address, city: "", state: "" } }}
        onChange={onChange}
        isDetectingLocation={false}
        onDetectLocation={vi.fn()}
      />
    );
    await user.type(screen.getByPlaceholderText(/enter city/i), "M");
    expect(onChange.mock.calls.at(-1)?.[0].target.name).toBe("address.city");

    const stateSelect = screen.getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(stateSelect, INDIAN_STATES[0]);
    expect(onChange.mock.calls.at(-1)?.[0].target.name).toBe("address.state");
  });
});
