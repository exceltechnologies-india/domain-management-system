/**
 * Component tests for <SessionProvider> (rescan-4 M14).
 * Tiny wrapper around next-auth's SessionProvider. The only behavior to
 * pin is that it renders its children — and that the next-auth provider
 * actually wraps them (so a future swap to a different auth library
 * surfaces as a test failure).
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

const wrapperMock = vi.hoisted(() =>
  vi.fn(({ children }: { children: React.ReactNode }) => (
    <div data-testid="nextauth-wrapper">{children}</div>
  ))
);
vi.mock("next-auth/react", () => ({
  SessionProvider: wrapperMock,
}));

import SessionProvider from "@/components/SessionProvider";

describe("<SessionProvider>", () => {
  it("wraps children with the next-auth SessionProvider", () => {
    render(
      <SessionProvider>
        <div data-testid="kid">hi</div>
      </SessionProvider>
    );
    expect(screen.getByTestId("nextauth-wrapper")).toBeInTheDocument();
    expect(screen.getByTestId("kid")).toBeInTheDocument();
    expect(wrapperMock).toHaveBeenCalled();
  });
});
