/**
 * Component tests for <MessageAttachments> (rescan-4 M14).
 * Pins the null/empty render-nothing path, the per-attachment anchor
 * shape (href=dataUrl, download=filename, target="_blank" + rel for
 * external safety, title carrying filename + size-in-KB), the inner
 * img alt, and the align-prop → justify-class mapping.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import MessageAttachments from "@/components/support/MessageAttachments";

const samplePng = {
  filename: "screenshot.png",
  mimeType: "image/png",
  size: 4096, // 4 KB
  dataUrl: "data:image/png;base64,xyz",
};

describe("<MessageAttachments>", () => {
  it("renders nothing for null or empty attachments", () => {
    const { container: c1 } = render(<MessageAttachments attachments={null} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(<MessageAttachments attachments={[]} />);
    expect(c2.firstChild).toBeNull();
  });

  it("renders one anchor per attachment carrying href, download, target, rel, and a title with filename + size in KB", () => {
    render(<MessageAttachments attachments={[samplePng]} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "data:image/png;base64,xyz");
    expect(link).toHaveAttribute("download", "screenshot.png");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // 4096 bytes / 1024 = 4 KB
    expect(link.getAttribute("title")).toMatch(/screenshot\.png · 4 KB · click to open/);
  });

  it("renders the inner <img> with the dataUrl as src and the filename as alt", () => {
    render(<MessageAttachments attachments={[samplePng]} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", samplePng.dataUrl);
    expect(img).toHaveAttribute("alt", samplePng.filename);
  });

  it("renders one link per attachment when multiple are provided", () => {
    const a = { ...samplePng, filename: "a.png" };
    const b = { ...samplePng, filename: "b.png" };
    render(<MessageAttachments attachments={[a, b]} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("download", "a.png");
    expect(links[1]).toHaveAttribute("download", "b.png");
  });

  it("maps the align prop to the appropriate flex justify class", () => {
    const { container: left } = render(<MessageAttachments attachments={[samplePng]} align="left" />);
    expect(left.firstChild).toHaveClass("justify-start");
    const { container: right } = render(<MessageAttachments attachments={[samplePng]} align="right" />);
    expect(right.firstChild).toHaveClass("justify-end");
    const { container: center } = render(<MessageAttachments attachments={[samplePng]} align="center" />);
    expect(center.firstChild).toHaveClass("justify-center");
  });

  it("defaults to left-aligned when no align prop is passed", () => {
    const { container } = render(<MessageAttachments attachments={[samplePng]} />);
    expect(container.firstChild).toHaveClass("justify-start");
  });
});
