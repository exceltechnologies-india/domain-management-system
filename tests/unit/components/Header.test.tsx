/**
 * Component tests for <Header> (rescan-4 M14).
 * Pure presentational shell. Pins the <header> element rendering with the
 * fixed-positioning class set and the children passthrough.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Header from "@/components/Header";

describe("<Header>", () => {
  it("renders children inside a <header> element", () => {
    render(<Header><nav>nav-content</nav></Header>);
    expect(document.querySelector("header")).not.toBeNull();
    expect(screen.getByText("nav-content")).toBeInTheDocument();
  });

  it("carries the fixed-positioning + z-50 classes", () => {
    render(<Header>x</Header>);
    const header = document.querySelector("header") as HTMLElement;
    expect(header.className).toMatch(/fixed/);
    expect(header.className).toMatch(/z-50/);
  });

  it("appends the className prop to the wrapper", () => {
    render(<Header className="my-extra-cls">x</Header>);
    expect((document.querySelector("header") as HTMLElement).className).toContain("my-extra-cls");
  });
});
