/**
 * Component tests for `useRazorpayCheckout` + its <Frame> component
 * (rescan-4 M14).
 *
 * Pins the postMessage protocol:
 *  - open() returns a Promise; Frame renders the iframe overlay.
 *  - parent listens for {type:"ready"} and posts {type:"open", options}
 *    back to the iframe's contentWindow.
 *  - {type:"success", payload} resolves the open Promise.
 *  - {type:"dismiss"} rejects with {kind:"dismissed"}.
 *  - {type:"error", message} rejects with {kind:"error", message}.
 *  - A second open() while the first is active rejects immediately.
 *  - Messages from a foreign origin are ignored (defence-in-depth).
 */
import { render, act, fireEvent } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  useRazorpayCheckout,
  type RazorpayCheckoutError,
} from "@/components/RazorpayCheckoutFrame";
import type {
  RazorpayCheckoutOptions,
  RazorpaySuccessPayload,
} from "@/lib/razorpay-checkout-protocol";

const OPTIONS: RazorpayCheckoutOptions = {
  key: "rzp_test_abc",
  amount: 9900,
  currency: "INR",
  name: "Test order",
};

function sendMessage(data: unknown, origin: string = window.location.origin) {
  fireEvent(window, new MessageEvent("message", { data, origin }));
}

describe("useRazorpayCheckout", () => {
  it("Frame() returns null when no checkout is active", () => {
    const { result } = renderHook(() => useRazorpayCheckout());
    const { container } = render(<result.current.Frame />);
    expect(container.firstChild).toBeNull();
  });

  it("Frame() renders an iframe overlay once open() is called", async () => {
    const { result } = renderHook(() => useRazorpayCheckout());
    let openP: Promise<RazorpaySuccessPayload>;
    act(() => {
      openP = result.current.open(OPTIONS);
    });
    const { container } = render(<result.current.Frame />);
    expect(container.querySelector("iframe")).not.toBeNull();
    // Drop the unresolved Promise to avoid an unhandled-rejection warning
    // if the test exits without settling it.
    openP!.catch(() => {});
  });

  it("'ready' from the iframe → parent posts {type:'open', options} back", async () => {
    const { result } = renderHook(() => useRazorpayCheckout());

    act(() => {
      result.current.open(OPTIONS).catch(() => {});
    });
    const { container } = render(<result.current.Frame />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    // jsdom synthesizes a contentWindow; stub postMessage to capture calls.
    const postSpy = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage: postSpy },
      configurable: true,
    });

    act(() => {
      sendMessage({ type: "ready" });
    });
    expect(postSpy).toHaveBeenCalledWith(
      { type: "open", options: OPTIONS },
      window.location.origin
    );
  });

  it("'success' message resolves the open() Promise with the payload", async () => {
    const { result } = renderHook(() => useRazorpayCheckout());
    let pending!: Promise<RazorpaySuccessPayload>;
    act(() => {
      pending = result.current.open(OPTIONS);
    });
    render(<result.current.Frame />);
    const payload: RazorpaySuccessPayload = {
      razorpay_order_id: "ord_1",
      razorpay_payment_id: "pay_1",
      razorpay_signature: "sig_1",
    };
    act(() => {
      sendMessage({ type: "success", payload });
    });
    await expect(pending).resolves.toEqual(payload);
  });

  it("'dismiss' message rejects with {kind:'dismissed'}", async () => {
    const { result } = renderHook(() => useRazorpayCheckout());
    let pending!: Promise<RazorpaySuccessPayload>;
    act(() => {
      pending = result.current.open(OPTIONS);
    });
    render(<result.current.Frame />);
    act(() => {
      sendMessage({ type: "dismiss" });
    });
    await expect(pending).rejects.toEqual({ kind: "dismissed" } satisfies RazorpayCheckoutError);
  });

  it("'error' message rejects with {kind:'error', message}", async () => {
    const { result } = renderHook(() => useRazorpayCheckout());
    let pending!: Promise<RazorpaySuccessPayload>;
    act(() => {
      pending = result.current.open(OPTIONS);
    });
    render(<result.current.Frame />);
    act(() => {
      sendMessage({ type: "error", message: "Network error" });
    });
    await expect(pending).rejects.toEqual({
      kind: "error",
      message: "Network error",
    } satisfies RazorpayCheckoutError);
  });

  it("opening a second checkout while one is active rejects immediately", async () => {
    const { result } = renderHook(() => useRazorpayCheckout());
    act(() => {
      result.current.open(OPTIONS).catch(() => {});
    });
    let secondP!: Promise<RazorpaySuccessPayload>;
    act(() => {
      secondP = result.current.open(OPTIONS);
    });
    await expect(secondP).rejects.toMatchObject({
      kind: "error",
      message: expect.stringMatching(/already in progress/i),
    });
  });

  it("ignores postMessage from a foreign origin", async () => {
    const { result } = renderHook(() => useRazorpayCheckout());
    let pending!: Promise<RazorpaySuccessPayload>;
    act(() => {
      pending = result.current.open(OPTIONS);
    });
    render(<result.current.Frame />);
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    act(() => {
      sendMessage({ type: "dismiss" }, "https://evil.example.com");
    });
    // Give microtasks a turn — the Promise must NOT have settled.
    await Promise.resolve();
    expect(settled).toBe(false);
    // Settle it so the test exits cleanly.
    act(() => {
      sendMessage({ type: "dismiss" });
    });
    await expect(pending).rejects.toEqual({ kind: "dismissed" });
  });
});
