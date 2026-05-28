/**
 * Component tests for <ContactForm> (rescan-4 M14).
 * Pins the form rendering, the happy-path apiClient payload + success-screen
 * swap, the "Send Another Message" return-to-form, and the failure-path
 * showErrorToast surfacing the route's message.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockApiPost, showSuccessToast, showErrorToast } = vi.hoisted(() => ({
  mockApiPost: vi.fn(),
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({ apiClient: { post: mockApiPost } }));
vi.mock("@/lib/toast", () => ({ showSuccessToast, showErrorToast }));
vi.mock("react-hot-toast", () => ({ default: vi.fn() }));

import ContactForm from "@/components/ContactForm";

beforeEach(() => {
  mockApiPost.mockReset();
  showSuccessToast.mockClear();
  showErrorToast.mockClear();
});

describe("<ContactForm>", () => {
  it("renders the heading and the four form fields", () => {
    render(<ContactForm />);
    expect(screen.getByRole("heading", { name: /send us a message/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter your full name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter your email address/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/what is this about/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/describe your inquiry/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
  });

  it("posts {name, email, subject, message, recaptchaToken: null} on submit and swaps to the success screen", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    render(<ContactForm />);

    await user.type(screen.getByPlaceholderText(/enter your full name/i), "Alice");
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "alice@example.com");
    await user.type(screen.getByPlaceholderText(/what is this about/i), "Pricing");
    await user.type(screen.getByPlaceholderText(/describe your inquiry/i), "Tell me more.");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/contact", {
      name: "Alice",
      email: "alice@example.com",
      subject: "Pricing",
      message: "Tell me more.",
      recaptchaToken: null,
    });
    expect(await screen.findByRole("heading", { name: /message sent!/i })).toBeInTheDocument();
    expect(showSuccessToast).toHaveBeenCalledWith(expect.stringMatching(/sent successfully/i));
  });

  it("returns to the form when 'Send Another Message' is clicked from the success screen", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    render(<ContactForm />);

    await user.type(screen.getByPlaceholderText(/enter your full name/i), "Alice");
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "alice@example.com");
    await user.type(screen.getByPlaceholderText(/what is this about/i), "Subject");
    await user.type(screen.getByPlaceholderText(/describe your inquiry/i), "Body");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByRole("heading", { name: /message sent!/i });

    await user.click(screen.getByRole("button", { name: /send another message/i }));
    // The form heading is back and the inputs are empty (formData was reset on success).
    expect(await screen.findByRole("heading", { name: /send us a message/i })).toBeInTheDocument();
    expect((screen.getByPlaceholderText(/enter your full name/i) as HTMLInputElement).value).toBe("");
  });

  it("surfaces the route's error.message via showErrorToast on a failed submit", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: false, error: { status: 400, message: "Rate limited" } });
    render(<ContactForm />);

    await user.type(screen.getByPlaceholderText(/enter your full name/i), "Alice");
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "alice@example.com");
    await user.type(screen.getByPlaceholderText(/what is this about/i), "Pricing");
    await user.type(screen.getByPlaceholderText(/describe your inquiry/i), "Hello.");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await vi.waitFor(() => expect(showErrorToast).toHaveBeenCalledWith("Rate limited"));
    // No swap to the success screen
    expect(screen.queryByRole("heading", { name: /message sent!/i })).not.toBeInTheDocument();
  });
});
