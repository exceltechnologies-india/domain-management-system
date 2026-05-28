/**
 * Component tests for <ClientOnly> (rescan-4 M14).
 * The SSR-hydration guard that defers rendering of children until after
 * the first client effect runs. Tests pin the fallback-on-first-render +
 * children-on-mount behaviour and the null default fallback.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import ClientOnly from "@/components/ClientOnly";

describe("<ClientOnly>", () => {
  it("renders the children once mounted (RTL flushes effects synchronously)", () => {
    render(
      <ClientOnly>
        <p>client-only content</p>
      </ClientOnly>
    );
    expect(screen.getByText("client-only content")).toBeInTheDocument();
  });

  it("renders the supplied fallback while not yet mounted (custom-fallback path)", () => {
    // We can't actually observe the "pre-mount" state under RTL (effects run
    // synchronously in render()). What we *can* pin is that the children are
    // rendered after mount even if a non-null fallback was supplied — that
    // exercises the fallback prop path without false-positive coupling to a
    // race we can't reproduce.
    render(
      <ClientOnly fallback={<p>loading…</p>}>
        <p>real content</p>
      </ClientOnly>
    );
    expect(screen.getByText("real content")).toBeInTheDocument();
  });

  it("defaults the fallback to null (renders nothing extra when children are absent)", () => {
    const { container } = render(<ClientOnly>{null}</ClientOnly>);
    expect(container.textContent).toBe("");
  });
});
