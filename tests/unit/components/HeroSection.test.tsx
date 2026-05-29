/**
 * Component tests for <HeroSection> (rescan-4 M14).
 * Pins the default gradient + primary variant classes, the secondary
 * and dark variants, the `background='solid'` branch (no gradient
 * classes), and the `backgroundImage` inline-style branch.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import HeroSection from "@/components/HeroSection";

describe("<HeroSection>", () => {
  it("default render uses the primary gradient classes and wraps children", () => {
    const { container } = render(
      <HeroSection>
        <h1>Find your domain</h1>
      </HeroSection>
    );
    expect(screen.getByRole("heading", { name: /find your domain/i })).toBeInTheDocument();
    const section = container.querySelector("section")!;
    expect(section.className).toMatch(/bg-gradient-to-r/);
    expect(section.className).toMatch(/from-primary-600/);
    expect(section.className).toMatch(/to-primary-800/);
  });

  it("variant='secondary' swaps to the gray gradient stops", () => {
    const { container } = render(<HeroSection variant="secondary">x</HeroSection>);
    const section = container.querySelector("section")!;
    expect(section.className).toMatch(/from-gray-600/);
    expect(section.className).toMatch(/to-gray-800/);
  });

  it("variant='dark' uses the gray-800→gray-900 gradient", () => {
    const { container } = render(<HeroSection variant="dark">x</HeroSection>);
    const section = container.querySelector("section")!;
    expect(section.className).toMatch(/from-gray-800/);
    expect(section.className).toMatch(/to-gray-900/);
  });

  it("background='solid' uses a single bg class and drops the gradient", () => {
    const { container } = render(
      <HeroSection background="solid">x</HeroSection>
    );
    const section = container.querySelector("section")!;
    expect(section.className).toMatch(/bg-primary-600/);
    expect(section.className).not.toMatch(/bg-gradient-to-r/);
  });

  it("backgroundImage prop applies inline backgroundImage style", () => {
    const { container } = render(
      <HeroSection backgroundImage="/img/hero.jpg">x</HeroSection>
    );
    const section = container.querySelector("section")! as HTMLElement;
    expect(section.style.backgroundImage).toContain("/img/hero.jpg");
  });
});
