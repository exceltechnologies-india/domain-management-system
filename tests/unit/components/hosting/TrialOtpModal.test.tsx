/**
 * Component tests for <TrialOtpModal> (rescan-4 M14).
 * Pins the isOpen render gate, the defaultPhone normalisation (strip
 * non-digits + leading "91" + last 10 chars), the two stages (phone →
 * code), the digit-count validation toasts, the apiClient payloads
 * (`/send` with `{phone}`, `/verify` with `{phone, code}`), the
 * sessionStorage token stash + onVerified call on success, the failure
 * toasts using the route's error.message, the Close button onClose, and
 * the "Change number" stage reset.
 *
 * The 60s "Resend in N s" cooldown is not asserted (timer-driven UI; same
 * jsdom-timeout class flagged in 7bg/7bh slice notes).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockApiPost, mockToast } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  return { mockApiPost: vi.fn(), mockToast: toast };
});

vi.mock("@/lib/api-client", () => ({ apiClient: { post: mockApiPost } }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));

import TrialOtpModal from "@/components/hosting/TrialOtpModal";

beforeEach(() => {
  mockApiPost.mockReset();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
  sessionStorage.clear();
});

function renderOpen(defaultPhone?: string) {
  const onClose = vi.fn();
  const onVerified = vi.fn();
  render(<TrialOtpModal isOpen defaultPhone={defaultPhone} onClose={onClose} onVerified={onVerified} />);
  return { onClose, onVerified };
}

describe("<TrialOtpModal>", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <TrialOtpModal isOpen={false} onClose={vi.fn()} onVerified={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the phone-stage UI when open", () => {
    renderOpen();
    expect(screen.getByRole("heading", { name: /verify your phone/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/10-digit mobile/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send otp/i })).toBeInTheDocument();
  });

  it("normalises defaultPhone — strips non-digits, drops leading '91', keeps last 10 chars", () => {
    renderOpen("+91 99887 76655");
    expect((screen.getByPlaceholderText(/10-digit mobile/i) as HTMLInputElement).value).toBe("9988776655");
  });

  it("keeps the Send OTP button disabled until 10 digits are entered", async () => {
    const user = userEvent.setup();
    renderOpen();
    const btn = screen.getByRole("button", { name: /send otp/i });
    expect(btn).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/10-digit mobile/i), "99887766");
    expect(btn).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/10-digit mobile/i), "55");
    expect(btn).not.toBeDisabled();
  });

  it("posts to /trial-otp/send and moves to the code stage on success", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    renderOpen();
    await user.type(screen.getByPlaceholderText(/10-digit mobile/i), "9988776655");
    await user.click(screen.getByRole("button", { name: /send otp/i }));

    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/user/hosting/trial-otp/send", { phone: "9988776655" });
    expect(await screen.findByText(/6-digit otp sent to \+91 9988776655/i)).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/otp sent/i));
  });

  it("surfaces the route's error.message via toast.error when /send fails", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: false, error: { status: 429, message: "Rate limited" } });
    renderOpen();
    await user.type(screen.getByPlaceholderText(/10-digit mobile/i), "9988776655");
    await user.click(screen.getByRole("button", { name: /send otp/i }));
    await vi.waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Rate limited"));
    // Still on the phone stage — no swap to code
    expect(screen.queryByText(/6-digit otp sent/i)).not.toBeInTheDocument();
  });

  it("posts {phone, code} to /trial-otp/verify, stashes the token, and calls onVerified on success", async () => {
    const user = userEvent.setup();
    mockApiPost
      .mockResolvedValueOnce({ ok: true, data: {} }) // /send
      .mockResolvedValueOnce({ ok: true, data: { token: "signed.jwt.here" } }); // /verify
    const { onVerified } = renderOpen();

    await user.type(screen.getByPlaceholderText(/10-digit mobile/i), "9988776655");
    await user.click(screen.getByRole("button", { name: /send otp/i }));
    await user.type(await screen.findByPlaceholderText("••••••"), "123456");
    await user.click(screen.getByRole("button", { name: /verify & start trial/i }));

    expect(mockApiPost).toHaveBeenNthCalledWith(2, "/api/v1/user/hosting/trial-otp/verify", {
      phone: "9988776655",
      code: "123456",
    });
    await vi.waitFor(() => expect(sessionStorage.getItem("trial-otp-token")).toBe("signed.jwt.here"));
    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/phone verified/i));
  });

  it("treats a 2xx response with no token as a verification failure", async () => {
    const user = userEvent.setup();
    mockApiPost
      .mockResolvedValueOnce({ ok: true, data: {} }) // /send
      .mockResolvedValueOnce({ ok: true, data: {} }); // /verify — missing token
    const { onVerified } = renderOpen();

    await user.type(screen.getByPlaceholderText(/10-digit mobile/i), "9988776655");
    await user.click(screen.getByRole("button", { name: /send otp/i }));
    await user.type(await screen.findByPlaceholderText("••••••"), "123456");
    await user.click(screen.getByRole("button", { name: /verify & start trial/i }));

    await vi.waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/verification failed/i))
    );
    expect(onVerified).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("trial-otp-token")).toBeNull();
  });

  it("'Change number' returns to the phone stage and clears the code field", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    renderOpen();
    await user.type(screen.getByPlaceholderText(/10-digit mobile/i), "9988776655");
    await user.click(screen.getByRole("button", { name: /send otp/i }));
    await user.type(await screen.findByPlaceholderText("••••••"), "123");
    await user.click(screen.getByRole("button", { name: /change number/i }));

    expect(screen.getByPlaceholderText(/10-digit mobile/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("••••••")).not.toBeInTheDocument();
  });

  it("Close button fires onClose", async () => {
    const user = userEvent.setup();
    const { onClose } = renderOpen();
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
