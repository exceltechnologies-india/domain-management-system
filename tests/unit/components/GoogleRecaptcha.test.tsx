/**
 * Component tests for <GoogleRecaptcha> (rescan-4 M14).
 * Heavy mock setup — `RecaptchaClient`, `apiClient`, `logger`, plus the
 * env var via vi.stubEnv. Pins the four early-return branches and the
 * happy-path render:
 *  1. captcha-status returns enabled=false → onSuccess('captcha-disabled')
 *     immediately (no widget rendered).
 *  2. NEXT_PUBLIC_RECAPTCHA_SITE_KEY missing/placeholder → onSuccess(
 *     'manual-pass'), no widget render.
 *  3. RecaptchaClient.render succeeds → calls render with the supplied
 *     theme + size; on its `callback`, forwards token to onSuccess.
 *  4. expired-callback fires onExpire + resets the widget.
 *  5. render() throwing 'already been rendered' is swallowed (no
 *     onError, no visible error).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recaptchaRender = vi.hoisted(() => vi.fn());
const recaptchaReset = vi.hoisted(() => vi.fn());
vi.mock("@/lib/recaptcha", () => ({
  RecaptchaClient: { render: recaptchaRender, reset: recaptchaReset },
}));

const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
  apiClient: { get: apiGetMock },
}));

vi.mock("@/lib/logger", () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import GoogleRecaptcha from "@/components/GoogleRecaptcha";

beforeEach(() => {
  recaptchaRender.mockReset();
  recaptchaReset.mockReset();
  apiGetMock.mockReset();
  // Default: captcha enabled in API + site key present.
  apiGetMock.mockResolvedValue({ ok: true, data: { enabled: true } });
  vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_SITE_KEY", "test-site-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("<GoogleRecaptcha>", () => {
  it("captcha-status enabled=false → onSuccess('captcha-disabled') and no widget render", async () => {
    apiGetMock.mockResolvedValueOnce({ ok: true, data: { enabled: false } });
    const onSuccess = vi.fn();
    render(<GoogleRecaptcha onSuccess={onSuccess} />);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("captcha-disabled"));
    expect(recaptchaRender).not.toHaveBeenCalled();
  });

  it("missing site key → onSuccess('manual-pass') and no widget render", async () => {
    vi.stubEnv("NEXT_PUBLIC_RECAPTCHA_SITE_KEY", "your-recaptcha-site-key");
    const onSuccess = vi.fn();
    render(<GoogleRecaptcha onSuccess={onSuccess} />);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("manual-pass"));
    expect(recaptchaRender).not.toHaveBeenCalled();
  });

  it("happy path: renders the widget with theme + size + a callback that forwards tokens", async () => {
    recaptchaRender.mockResolvedValue(42);
    const onSuccess = vi.fn();
    render(<GoogleRecaptcha theme="dark" size="compact" onSuccess={onSuccess} />);
    await waitFor(() => expect(recaptchaRender).toHaveBeenCalled());
    const [container, opts] = recaptchaRender.mock.calls[0];
    expect(container).toBeInstanceOf(HTMLDivElement);
    expect(opts.theme).toBe("dark");
    expect(opts.size).toBe("compact");
    // The widget's success callback forwards the token to onSuccess.
    opts.callback("token-xyz");
    expect(onSuccess).toHaveBeenCalledWith("token-xyz");
  });

  it("widget expired-callback fires onExpire + resets the widget", async () => {
    recaptchaRender.mockResolvedValue(7);
    const onExpire = vi.fn();
    render(<GoogleRecaptcha onExpire={onExpire} />);
    await waitFor(() => expect(recaptchaRender).toHaveBeenCalled());
    const opts = recaptchaRender.mock.calls[0][1];
    opts["expired-callback"]();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(recaptchaReset).toHaveBeenCalledWith(7);
  });

  it("widget error-callback fires onError + shows a visible error message", async () => {
    recaptchaRender.mockResolvedValue(1);
    const onError = vi.fn();
    render(<GoogleRecaptcha onError={onError} />);
    await waitFor(() => expect(recaptchaRender).toHaveBeenCalled());
    const opts = recaptchaRender.mock.calls[0][1];
    opts["error-callback"]();
    expect(onError).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText(/recaptcha verification failed/i)).toBeInTheDocument()
    );
  });

  it("render() throwing 'already been rendered' is swallowed (no onError, no visible error)", async () => {
    recaptchaRender.mockRejectedValueOnce(new Error("reCAPTCHA has already been rendered in this element"));
    const onError = vi.fn();
    render(<GoogleRecaptcha onError={onError} />);
    await waitFor(() => expect(recaptchaRender).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByText(/failed to render verification/i)).not.toBeInTheDocument();
  });

  it("render() throwing any other error → onError + visible 'Failed to render' message", async () => {
    recaptchaRender.mockRejectedValueOnce(new Error("script load failed"));
    const onError = vi.fn();
    render(<GoogleRecaptcha onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByText(/failed to render verification widget/i)).toBeInTheDocument();
  });
});
