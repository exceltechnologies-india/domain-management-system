/**
 * Component tests for the CustomToast renderer + convenience APIs
 * (rescan-4 M14). The toast itself is an imperative API: `showCustomToast`
 * registers a render function with react-hot-toast and returns the toast
 * id. We mock `toast.custom` to capture the render fn, then mount it
 * standalone (with a fake `Toast` arg) to assert the rendered chrome:
 *  - per-type border-l-4 color stripe
 *  - per-type icon (svg vs spinner)
 *  - title rendering when supplied
 *  - dismiss button calls `toast.dismiss(t.id)`
 *  - showLoadingToast / showPermanentToast pin `duration=Infinity`.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Toast } from "react-hot-toast";

type CustomToastFn = (
  renderFn: (t: import("react-hot-toast").Toast) => React.ReactElement,
  opts?: { duration?: number; position?: string }
) => string;
const customMock = vi.hoisted(() =>
  vi.fn<CustomToastFn>(() => "toast-id-xyz" as string)
);
const dismissMock = vi.hoisted(() => vi.fn());

vi.mock("react-hot-toast", () => ({
  default: { custom: customMock, dismiss: dismissMock },
  __esModule: true,
}));

import {
  showCustomToast,
  showSuccessToast,
  showErrorToast,
  showLoadingToast,
  showPermanentToast,
} from "@/components/CustomToast";

function fakeToast(overrides: Partial<Toast> = {}): Toast {
  return {
    id: "t1",
    visible: true,
    type: "blank",
    message: "",
    pauseDuration: 0,
    createdAt: 0,
    ariaProps: { role: "status", "aria-live": "polite" },
    ...overrides,
  } as Toast;
}

beforeEach(() => {
  customMock.mockClear();
  dismissMock.mockClear();
});

describe("CustomToast", () => {
  it("showCustomToast registers a render fn with react-hot-toast", () => {
    const id = showSuccessToast("hello", "Done");
    expect(id).toBe("toast-id-xyz");
    expect(customMock).toHaveBeenCalledTimes(1);
  });

  it("success render shows the title + green border + checkmark icon", () => {
    showSuccessToast("Saved", "Done");
    const renderFn = customMock.mock.calls[0][0] as (t: Toast) => React.ReactElement;
    const { container } = render(renderFn(fakeToast()));
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(container.querySelector(".border-green-500")).not.toBeNull();
  });

  it("error render uses the red border + the red 'x' close-icon variant", () => {
    showErrorToast("Boom");
    const renderFn = customMock.mock.calls[0][0] as (t: Toast) => React.ReactElement;
    const { container } = render(renderFn(fakeToast()));
    expect(container.querySelector(".border-red-500")).not.toBeNull();
  });

  it("loading render uses the blue border + an animate-spin spinner instead of an svg", () => {
    showLoadingToast("Working");
    expect(customMock).toHaveBeenCalledTimes(1);
    const [renderFn, opts] = customMock.mock.calls[0] as [
      (t: Toast) => React.ReactElement,
      { duration: number; position: string },
    ];
    expect(opts.duration).toBe(Infinity);
    const { container } = render(renderFn(fakeToast()));
    expect(container.querySelector(".border-blue-500")).not.toBeNull();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("dismiss button clicks call toast.dismiss with the toast id", async () => {
    const user = userEvent.setup();
    showSuccessToast("Saved");
    const renderFn = customMock.mock.calls[0][0] as (t: Toast) => React.ReactElement;
    render(renderFn(fakeToast({ id: "abc" })));
    await user.click(screen.getByRole("button"));
    expect(dismissMock).toHaveBeenCalledWith("abc");
  });

  it("showPermanentToast sets duration=Infinity (dismissible by default)", () => {
    showPermanentToast("Account deactivated");
    const opts = customMock.mock.calls[0][1] as { duration: number };
    expect(opts.duration).toBe(Infinity);
  });

  it("showCustomToast with dismissible=false omits the X dismiss button", () => {
    showCustomToast({ type: "error", message: "x", dismissible: false });
    const renderFn = customMock.mock.calls[0][0] as (t: Toast) => React.ReactElement;
    render(renderFn(fakeToast()));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
