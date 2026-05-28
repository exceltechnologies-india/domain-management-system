/**
 * Component tests for <AttachmentPicker> (rescan-4 M14).
 * Pins the trigger + helper-text render, the custom-label prop, the
 * thumbnail grid with filename caption + remove button, the remove-by-index
 * callback, the file-validation gates (count > MAX_FILES, non-image, wrong
 * mime, over MAX_BYTES) each surfacing a toast and *not* calling onChange,
 * the happy-path upload (FileReader-produced data URL + the new attachment
 * shape forwarded via onChange), and the trigger disabled state when
 * attachments are at capacity.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockToast } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  return { mockToast: toast };
});

vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));

import AttachmentPicker, {
  MAX_FILES,
  MAX_BYTES,
  type PickedAttachment,
} from "@/components/support/AttachmentPicker";

const existing: PickedAttachment = {
  filename: "old.png",
  mimeType: "image/png",
  size: 1024,
  dataUrl: "data:image/png;base64,old",
};

beforeEach(() => {
  mockToast.error.mockClear();
  mockToast.success.mockClear();
});

describe("<AttachmentPicker>", () => {
  it("renders the default trigger label and the helper hint", () => {
    render(<AttachmentPicker attachments={[]} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /attach images/i })).toBeInTheDocument();
    expect(screen.getByText(/png, jpg, webp, gif/i)).toBeInTheDocument();
    expect(screen.getByText(/up to 4 images/i)).toBeInTheDocument();
  });

  it("honours the custom `label` prop", () => {
    render(<AttachmentPicker attachments={[]} onChange={vi.fn()} label="Add screenshot" />);
    expect(screen.getByRole("button", { name: /add screenshot/i })).toBeInTheDocument();
  });

  it("renders existing attachments as a thumbnail grid with filename caption + remove button", () => {
    render(<AttachmentPicker attachments={[existing]} onChange={vi.fn()} />);
    const img = screen.getByAltText("old.png") as HTMLImageElement;
    expect(img.src).toBe(existing.dataUrl);
    expect(screen.getByText("old.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("removes the right attachment via the X button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const second: PickedAttachment = { ...existing, filename: "second.png" };
    render(<AttachmentPicker attachments={[existing, second]} onChange={onChange} />);
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith([second]);
  });

  it("blocks > MAX_FILES with a toast and does NOT call onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // 3 existing + 2 selected = 5 > MAX_FILES (4)
    const three = [existing, { ...existing, filename: "b.png" }, { ...existing, filename: "c.png" }];
    render(<AttachmentPicker attachments={three} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const f1 = new File(["aa"], "x.png", { type: "image/png" });
    const f2 = new File(["bb"], "y.png", { type: "image/png" });
    await user.upload(input, [f1, f2]);
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/at most 4 images/i));
    expect(onChange).not.toHaveBeenCalled();
  });

  // The input has `accept="image/jpeg,image/png,image/webp,image/gif"`. Both
  // user-event's upload and jsdom's own accept filter silently drop files
  // whose type doesn't match — we want to test the JS-side validation in
  // handleFiles (which is the second line of defence behind the attr), so
  // we dispatch the change event directly with a synthetic FileList.
  function uploadDirectly(input: HTMLInputElement, files: File[]) {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    fireEvent.change(input);
  }

  it("rejects non-image files with a toast and does NOT call onChange", async () => {
    const onChange = vi.fn();
    render(<AttachmentPicker attachments={[]} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const txt = new File(["hello"], "notes.txt", { type: "text/plain" });
    uploadDirectly(input, [txt]);
    await vi.waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/isn't an image/i))
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects images whose mime is outside the JPEG/PNG/WebP/GIF allowlist", async () => {
    const onChange = vi.fn();
    render(<AttachmentPicker attachments={[]} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const heic = new File(["aa"], "photo.heic", { type: "image/heic" });
    uploadDirectly(input, [heic]);
    await vi.waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/only jpeg, png, webp, gif allowed/i))
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects files larger than MAX_BYTES with a toast", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AttachmentPicker attachments={[]} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // Create a "big" file by giving it a 3MB-ish buffer
    const bigBlob = new Uint8Array(MAX_BYTES + 1);
    const big = new File([bigBlob], "big.png", { type: "image/png" });
    await user.upload(input, big);
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/is over 2 mb/i));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts a valid image and forwards the new attachment shape via onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AttachmentPicker attachments={[]} onChange={onChange} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["pretend png bytes"], "screenshot.png", { type: "image/png" });
    await user.upload(input, file);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const pushed = onChange.mock.calls[0][0] as PickedAttachment[];
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      filename: "screenshot.png",
      mimeType: "image/png",
      size: file.size,
    });
    expect(pushed[0].dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("disables the trigger when attachments are already at capacity (MAX_FILES)", () => {
    const four = Array.from({ length: MAX_FILES }, (_, i) => ({
      ...existing,
      filename: `f${i}.png`,
    }));
    render(<AttachmentPicker attachments={four} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /attach images/i })).toBeDisabled();
  });
});
