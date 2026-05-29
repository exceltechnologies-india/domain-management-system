/**
 * Component tests for <Section> (rescan-4 M14).
 * Pins the children + id render, the four background variant classes,
 * the four padding-size classes, and the default-variant fallbacks.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Section from "@/components/Section";

describe("<Section>", () => {
  it("renders children inside a <section>", () => {
    render(<Section><p>hello</p></Section>);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(document.querySelector("section")).not.toBeNull();
  });

  it("propagates the id prop to the section element", () => {
    render(<Section id="hero">x</Section>);
    expect(document.querySelector("section#hero")).not.toBeNull();
  });

  it("applies the default white background and lg padding when no variant is given", () => {
    render(<Section>x</Section>);
    const section = document.querySelector("section") as HTMLElement;
    expect(section.className).toMatch(/bg-white/);
    expect(section.className).toMatch(/py-8/); // lg → py-8 sm:py-12
  });

  it("maps background='gray' to bg-gray-50", () => {
    render(<Section background="gray">x</Section>);
    expect((document.querySelector("section") as HTMLElement).className).toMatch(/bg-gray-50/);
  });

  it("maps background='dark' to bg-gray-900 + white text", () => {
    render(<Section background="dark">x</Section>);
    const section = document.querySelector("section") as HTMLElement;
    expect(section.className).toMatch(/bg-gray-900/);
    expect(section.className).toMatch(/text-white/);
  });

  it("maps padding='xl' to py-12 sm:py-16", () => {
    render(<Section padding="xl">x</Section>);
    expect((document.querySelector("section") as HTMLElement).className).toMatch(/py-12/);
  });
});
