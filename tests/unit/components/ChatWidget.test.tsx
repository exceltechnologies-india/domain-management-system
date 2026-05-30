/**
 * Component tests for <ChatWidget> (rescan-4 M14).
 * The 260-line streaming-SSE chat widget. Pins:
 *  - Closed by default; click toggle button opens the panel.
 *  - Greeting message renders when sessionStorage is empty.
 *  - sessionStorage hydration restores prior conversation on mount;
 *    a trailing empty assistant message (interrupted stream) is dropped.
 *  - Send button disabled when input is empty.
 *  - Send streams: appends user msg + empty assistant placeholder, then
 *    accumulates 'data: {...}' chunks into the trailing assistant
 *    message; final state shows the full accumulated text.
 *  - Malformed chunk lines are skipped (don't crash the stream).
 *  - Network failure → assistant fallback 'Sorry, something went wrong…'.
 *  - sessionStorage persists each settled exchange (mid-stream skipped).
 *  - Enter key (no shift) submits.
 *  - Close (X) button hides the panel.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import ChatWidget from "@/components/ChatWidget";

// Build a mock ReadableStream that yields the supplied SSE-style chunks.
function makeStreamingResponse(chunks: string[]) {
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () =>
          i < chunks.length
            ? Promise.resolve({
                done: false,
                value: new TextEncoder().encode(chunks[i++]),
              })
            : Promise.resolve({ done: true, value: undefined }),
      }),
    },
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  sessionStorage.clear();
  // Stub Element.scrollIntoView (jsdom no-op friendly).
  Element.prototype.scrollIntoView = vi.fn();
});

describe("<ChatWidget>", () => {
  it("renders the toggle button + panel hidden by default", () => {
    render(<ChatWidget />);
    expect(screen.getByRole("button", { name: /open chat/i })).toBeInTheDocument();
    expect(screen.queryByText(/anutech assistant/i)).not.toBeInTheDocument();
  });

  it("clicking the toggle button opens the chat panel with the greeting", async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    expect(screen.getByText(/anutech assistant/i)).toBeInTheDocument();
    expect(screen.getByText(/i'm anutech's assistant/i)).toBeInTheDocument();
  });

  it("clicking Close (X) inside the panel hides it", async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    // When open, BOTH the header X and the toggle button carry aria-label
    // 'Close chat'. The header X is the first in source order.
    const closeButtons = screen.getAllByRole("button", { name: /close chat/i });
    expect(closeButtons.length).toBeGreaterThanOrEqual(1);
    await user.click(closeButtons[0]);
    await waitFor(() =>
      expect(screen.queryByText(/anutech assistant/i)).not.toBeInTheDocument()
    );
  });

  it("sessionStorage hydration restores prior messages on mount", async () => {
    sessionStorage.setItem(
      "anutech_chat_messages",
      JSON.stringify([
        { role: "user", content: "what is your refund policy?" },
        { role: "assistant", content: "We offer 7-day refunds on domain registrations." },
      ])
    );
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    expect(screen.getByText("what is your refund policy?")).toBeInTheDocument();
    expect(screen.getByText(/7-day refunds on domain registrations/)).toBeInTheDocument();
    // The greeting should NOT be in the restored conversation.
    expect(screen.queryByText(/i'm anutech's assistant/i)).not.toBeInTheDocument();
  });

  it("hydration drops a trailing empty assistant message (interrupted stream)", async () => {
    sessionStorage.setItem(
      "anutech_chat_messages",
      JSON.stringify([
        { role: "user", content: "ping" },
        { role: "assistant", content: "" }, // mid-stream interruption
      ])
    );
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    expect(screen.getByText("ping")).toBeInTheDocument();
    // The empty placeholder is dropped → no 'Typing…' shell visible.
    expect(screen.queryByText(/typing/i)).not.toBeInTheDocument();
  });

  it("Send button is disabled while input is empty", async () => {
    const user = userEvent.setup();
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    const sendBtn = screen.getByRole("button", { name: /send message/i });
    expect(sendBtn).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/ask about domains or hosting/i), "hi");
    expect(sendBtn).not.toBeDisabled();
  });

  it("send streams chunks into the trailing assistant message and persists when settled", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      makeStreamingResponse([
        'data: {"text":"Hello "}\n',
        'data: {"text":"there!"}\n',
        "data: [DONE]\n",
      ])
    );
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    await user.type(screen.getByPlaceholderText(/ask about domains or hosting/i), "hi");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(screen.getByText("Hello there!")).toBeInTheDocument());
    expect(screen.getByText("hi")).toBeInTheDocument();
    // POST hit /api/v1/chat with the user message in the body.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
    // sessionStorage updated with the settled exchange.
    await waitFor(() => {
      const raw = sessionStorage.getItem("anutech_chat_messages");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      // last 2 entries are the user message + assistant accumulated reply
      expect(parsed.at(-2)).toMatchObject({ role: "user", content: "hi" });
      expect(parsed.at(-1)).toMatchObject({ role: "assistant", content: "Hello there!" });
    });
  });

  it("malformed chunks are silently skipped without crashing the stream", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      makeStreamingResponse([
        'data: {"text":"Hi "}\n',
        "data: this-is-not-json\n",
        'data: {"text":"again"}\n',
        "data: [DONE]\n",
      ])
    );
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    await user.type(screen.getByPlaceholderText(/ask about domains or hosting/i), "hi");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(screen.getByText("Hi again")).toBeInTheDocument());
  });

  it("network failure → assistant fallback message", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce({ ok: false, body: null });
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    await user.type(screen.getByPlaceholderText(/ask about domains or hosting/i), "hi");
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/sorry, something went wrong.*support@anutech\.in/i)
      ).toBeInTheDocument()
    );
  });

  it("Enter key (without shift) submits the message; Shift+Enter does not", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      makeStreamingResponse(['data: {"text":"ok"}\n', "data: [DONE]\n"])
    );
    render(<ChatWidget />);
    await user.click(screen.getByRole("button", { name: /open chat/i }));
    const input = screen.getByPlaceholderText(/ask about domains or hosting/i);
    await user.type(input, "hello");
    fetchMock.mockClear();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
