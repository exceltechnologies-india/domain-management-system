/**
 * Component tests for <ProfileCompletionForm> (rescan-4 M14).
 * Pins the disabled name/email render (those come from the user prop and
 * aren't editable in this step), the happy-path POST shape (phoneCc=+91
 * and address.country=IN are *forced* on submit regardless of any
 * client-side tampering), the localStorage merge + the `profileUpdated`
 * window event dispatch, the success-toast + router.push to /dashboard
 * (or `?returnUrl=` when present), the failure-path error toast (no
 * navigation), and the GST input upper-casing.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockRouter, mockApiPost, mockToast, mockLocalStorage } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  return {
    mockRouter: { push: vi.fn() },
    mockApiPost: vi.fn(),
    mockToast: toast,
    mockLocalStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => mockRouter }));
vi.mock("@/lib/api-client", () => ({ apiClient: { post: mockApiPost } }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));
vi.mock("@/lib/storage", () => ({ safeLocalStorage: mockLocalStorage }));

import ProfileCompletionForm from "@/components/ProfileCompletionForm";

const sampleUser = {
  id: "u1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Doe",
};

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/enter your phone number/i), "9999988888");
  await user.type(screen.getByPlaceholderText(/enter your company name/i), "Acme Inc");
  await user.type(screen.getByPlaceholderText(/enter your address$/i), "1 Some Road");
  await user.type(screen.getByPlaceholderText(/enter your city/i), "Mumbai");
  await user.type(screen.getByPlaceholderText(/enter your state/i), "MH");
  await user.type(screen.getByPlaceholderText(/enter your zip code/i), "400001");
}

beforeEach(() => {
  mockRouter.push.mockClear();
  mockApiPost.mockReset();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
  mockLocalStorage.getItem.mockReset();
  mockLocalStorage.setItem.mockReset();
  mockLocalStorage.getItem.mockReturnValue(null);
  // Reset the URL between tests so the returnUrl test can set it deterministically
  window.history.replaceState({}, "", "/");
});

describe("<ProfileCompletionForm>", () => {
  it("renders the heading and the disabled name/email from the user prop", () => {
    render(<ProfileCompletionForm user={sampleUser} />);
    expect(screen.getByRole("heading", { name: /complete your profile/i })).toBeInTheDocument();
    // The three disabled inputs show their value from the user prop
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const disabledValues = inputs.filter((i) => i.disabled).map((i) => i.value);
    expect(disabledValues).toEqual(expect.arrayContaining(["Alice", "Doe", "alice@example.com"]));
  });

  it("posts the form with phoneCc=+91 and address.country=IN forced, then routes to /dashboard", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: { user: { profileCompleted: true } } });
    const onComplete = vi.fn();
    render(<ProfileCompletionForm user={sampleUser} onComplete={onComplete} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /complete profile/i }));

    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/user/complete-profile", {
      phone: "9999988888",
      phoneCc: "+91",
      companyName: "Acme Inc",
      gstNumber: "",
      address: {
        line1: "1 Some Road",
        city: "Mumbai",
        state: "MH",
        country: "IN",
        zipcode: "400001",
      },
    });
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/profile completed/i));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith("/dashboard");
  });

  it("merges the response user into localStorage and dispatches the profileUpdated window event", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: true,
      data: { user: { profileCompleted: true, profile: { city: "Mumbai" } } },
    });
    mockLocalStorage.getItem.mockReturnValue(
      JSON.stringify({ id: "u1", email: "alice@example.com" })
    );
    const eventSpy = vi.fn();
    window.addEventListener("profileUpdated", eventSpy);

    render(<ProfileCompletionForm user={sampleUser} />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /complete profile/i }));

    await vi.waitFor(() => expect(mockLocalStorage.setItem).toHaveBeenCalledWith("user", expect.any(String)));
    const written = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
    expect(written).toMatchObject({
      id: "u1",
      email: "alice@example.com",
      profileCompleted: true,
      profile: { city: "Mumbai" },
    });
    expect(eventSpy).toHaveBeenCalled();
    window.removeEventListener("profileUpdated", eventSpy);
  });

  it("routes to the URL's returnUrl query param when present, falling back to /dashboard otherwise", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: { user: {} } });
    window.history.replaceState({}, "", "/?returnUrl=%2Fcart");
    render(<ProfileCompletionForm user={sampleUser} />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /complete profile/i }));
    await vi.waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/cart"));
  });

  it("surfaces the route's error.message on failure and does not navigate", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: false, error: { status: 400, message: "GSTIN invalid" } });
    render(<ProfileCompletionForm user={sampleUser} />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /complete profile/i }));

    await vi.waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("GSTIN invalid"));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("upper-cases the GST input as the user types", async () => {
    const user = userEvent.setup();
    render(<ProfileCompletionForm user={sampleUser} />);
    const gst = screen.getByPlaceholderText(/enter gstin/i) as HTMLInputElement;
    await user.type(gst, "27aaaaa0000a1z5");
    expect(gst.value).toBe("27AAAAA0000A1Z5");
  });
});
