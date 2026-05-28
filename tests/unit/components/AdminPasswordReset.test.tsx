/**
 * Component tests for <AdminPasswordReset> (rescan-4 M14).
 * Small admin-tool form. Pins the submit-disabled gating (empty / mismatch),
 * the < 8 chars validation toast, the apiClient.post payload, the success
 * path (success toast + fields cleared), and the failure path (route's
 * error.message surfaced).
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

import AdminPasswordReset from "@/components/AdminPasswordReset";

beforeEach(() => {
  mockApiPost.mockReset();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
});

describe("<AdminPasswordReset>", () => {
  it("renders the heading and disables the submit button when fields are empty", () => {
    render(<AdminPasswordReset />);
    expect(screen.getByRole("heading", { name: /reset admin password/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update password/i })).toBeDisabled();
  });

  it("keeps the submit disabled while the two passwords don't match", async () => {
    const user = userEvent.setup();
    render(<AdminPasswordReset />);
    await user.type(screen.getByPlaceholderText(/enter new password/i), "abcd1234");
    await user.type(screen.getByPlaceholderText(/confirm new password/i), "abcd5678");
    expect(screen.getByRole("button", { name: /update password/i })).toBeDisabled();
  });

  it("toasts an error when the matching passwords are shorter than 8 characters", async () => {
    const user = userEvent.setup();
    render(<AdminPasswordReset />);
    await user.type(screen.getByPlaceholderText(/enter new password/i), "abc");
    await user.type(screen.getByPlaceholderText(/confirm new password/i), "abc");
    // Both fields match + truthy, so the button enables; the length guard runs on click.
    await user.click(screen.getByRole("button", { name: /update password/i }));
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/at least 8 characters/i));
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("posts to /api/v1/admin/reset-password, toasts success, and clears the form on success", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    render(<AdminPasswordReset />);
    const pw = screen.getByPlaceholderText(/enter new password/i) as HTMLInputElement;
    const cpw = screen.getByPlaceholderText(/confirm new password/i) as HTMLInputElement;
    await user.type(pw, "ValidPass123!");
    await user.type(cpw, "ValidPass123!");
    await user.click(screen.getByRole("button", { name: /update password/i }));

    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/admin/reset-password", {
      newPassword: "ValidPass123!",
      confirmPassword: "ValidPass123!",
    });
    await vi.waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/updated successfully/i))
    );
    expect(pw.value).toBe("");
    expect(cpw.value).toBe("");
  });

  it("toasts the route's error.message on a failed submit", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: false, error: { status: 400, message: "Old password incorrect" } });
    render(<AdminPasswordReset />);
    await user.type(screen.getByPlaceholderText(/enter new password/i), "ValidPass123!");
    await user.type(screen.getByPlaceholderText(/confirm new password/i), "ValidPass123!");
    await user.click(screen.getByRole("button", { name: /update password/i }));
    await vi.waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith("Old password incorrect")
    );
  });
});
