/**
 * Tests for `app/api/chat/route.ts` (slice 7i2, part 1).
 *
 * Public AI chat widget. Anonymous, rate-limited, SSE-streamed
 * Anthropic Haiku 4.5 conversations.
 *
 * Threat model:
 *  - **Budget-drain abuse**: a single hostile IP could otherwise
 *    flood the Anthropic API and drain the team's quota. Pinned:
 *    10 requests per IP per minute BEFORE body parse (so a hostile
 *    large body can't even reach the JSON parser when throttled).
 *  - **Model-alias re-point cost shift**: a future Anthropic alias
 *    redirect (e.g. claude-haiku-* → a more expensive tier) would
 *    silently change the per-conversation cost. Pinned to the
 *    dated release `claude-haiku-4-5-20251001`.
 *  - **Conversation-history token bomb**: a refactor that drops
 *    the `.slice(-20)` cost-bound would let clients send 1000-turn
 *    histories and burn tokens. Pinned with a 25-message probe
 *    asserting only 20 reach the SDK.
 *
 * Other pins:
 *  - Rate-limit BEFORE body parse
 *  - zod: messages array min:1; role enum 'user'|'assistant';
 *    content 1-8000 chars
 *  - SSE Content-Type / Cache-Control: no-cache / Connection: keep-alive
 *  - text_delta events → `data: {text}\n\n` chunks
 *  - non-text-delta events filtered out
 *  - `data: [DONE]\n\n` sentinel at end
 *  - System prompt array w/ cache_control: ephemeral pinned
 *  - max_tokens: 1024 pinned
 *  - Anthropic error mapping: AuthenticationError → 401;
 *    RateLimitError → 429; other → 500
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return {
    ...actual,
    rateLimiters: { chat: { isAllowed } },
  };
});

const stream = vi.hoisted(() => vi.fn());
const AnthropicMock = vi.hoisted(() => {
  class AuthenticationError extends Error {}
  class RateLimitError extends Error {}
  class Anthropic {
    messages = { stream };
    static AuthenticationError = AuthenticationError;
    static RateLimitError = RateLimitError;
  }
  return Anthropic;
});
vi.mock("@anthropic-ai/sdk", () => ({ default: AnthropicMock }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/chat/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Async iterable producing the Anthropic SDK event stream. */
function makeEventStream(
  events: Array<Record<string, unknown>>
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
  };
}

function textDelta(text: string) {
  return {
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  };
}

async function readSSEChunks(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      chunks.push(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

const VALID = { messages: [{ role: "user", content: "Hello" }] };

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true, remaining: 10 });
  stream.mockReset();
});

describe("Rate-limit BEFORE body parse (anti-budget-drain)", () => {
  it("denied → 429; body NEVER parsed; SDK NEVER called", async () => {
    isAllowed.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    // Hostile body bytes — if rate-limit ran after parse, this would 400.
    const res = await POST(makeReq("{not-json"));
    expect(res.status).toBe(429);
    expect(stream).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("empty messages array → 400 (min:1)", async () => {
    const res = await POST(makeReq({ messages: [] }));
    expect(res.status).toBe(400);
    expect(stream).not.toHaveBeenCalled();
  });

  it("missing messages → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("invalid role → 400", async () => {
    const res = await POST(
      makeReq({ messages: [{ role: "system", content: "hi" }] })
    );
    expect(res.status).toBe(400);
  });

  it("content > 8000 chars → 400", async () => {
    const res = await POST(
      makeReq({
        messages: [{ role: "user", content: "x".repeat(8001) }],
      })
    );
    expect(res.status).toBe(400);
  });

  it("content empty string → 400 (min:1)", async () => {
    const res = await POST(
      makeReq({ messages: [{ role: "user", content: "" }] })
    );
    expect(res.status).toBe(400);
  });
});

describe("Conversation history cost-bound (.slice(-20))", () => {
  it("25 messages sent → only last 20 reach the SDK", async () => {
    stream.mockResolvedValueOnce(makeEventStream([]));
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    }));
    await POST(makeReq({ messages }));
    expect(stream).toHaveBeenCalledTimes(1);
    const sdkCall = stream.mock.calls[0][0];
    expect(sdkCall.messages).toHaveLength(20);
    // First message in sdk call should be msg-5 (oldest of the last 20)
    expect(sdkCall.messages[0].content).toBe("msg-5");
    expect(sdkCall.messages[19].content).toBe("msg-24");
  });

  it("3 messages → all 3 reach the SDK (no truncation)", async () => {
    stream.mockResolvedValueOnce(makeEventStream([]));
    await POST(
      makeReq({
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
      })
    );
    expect(stream.mock.calls[0][0].messages).toHaveLength(3);
  });
});

describe("Anthropic SDK call shape", () => {
  it("**model pinned to dated release `claude-haiku-4-5-20251001`**", async () => {
    stream.mockResolvedValueOnce(makeEventStream([]));
    await POST(makeReq(VALID));
    expect(stream.mock.calls[0][0].model).toBe("claude-haiku-4-5-20251001");
  });

  it("max_tokens: 1024 pinned", async () => {
    stream.mockResolvedValueOnce(makeEventStream([]));
    await POST(makeReq(VALID));
    expect(stream.mock.calls[0][0].max_tokens).toBe(1024);
  });

  it("system prompt is an array w/ cache_control: ephemeral", async () => {
    stream.mockResolvedValueOnce(makeEventStream([]));
    await POST(makeReq(VALID));
    const system = stream.mock.calls[0][0].system;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0]).toEqual(
      expect.objectContaining({
        type: "text",
        cache_control: { type: "ephemeral" },
      })
    );
    expect(system[0].text).toContain("Anutech");
  });
});

describe("SSE streaming response", () => {
  it("Content-Type: text/event-stream + Cache-Control: no-cache + Connection: keep-alive", async () => {
    stream.mockResolvedValueOnce(makeEventStream([]));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  it("text_delta events → `data: {text}\\n\\n` chunks; non-text events filtered", async () => {
    stream.mockResolvedValueOnce(
      makeEventStream([
        { type: "message_start" }, // filtered
        textDelta("Hello "),
        { type: "ping" }, // filtered
        textDelta("world!"),
        { type: "message_stop" }, // filtered
      ])
    );
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    // 2 text-delta chunks + 1 [DONE] sentinel
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(data).toHaveLength(3);
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "Hello " });
    expect(JSON.parse(data[1].slice(6))).toEqual({ text: "world!" });
    expect(data[2]).toBe("data: [DONE]");
  });

  it("non-text_delta content_block_delta (e.g. tool-use delta) filtered out", async () => {
    stream.mockResolvedValueOnce(
      makeEventStream([
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        textDelta("real text"),
      ])
    );
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(data).toHaveLength(2); // text + DONE
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "real text" });
  });

  it("empty stream → only the `[DONE]` sentinel emitted", async () => {
    stream.mockResolvedValueOnce(makeEventStream([]));
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(data).toEqual(["data: [DONE]"]);
  });
});

describe("Stream error mid-flight", () => {
  it("iterator throws → emits `data: {error: 'Stream error'}` then closes", async () => {
    const errorStream = {
      [Symbol.asyncIterator]: async function* () {
        yield textDelta("partial");
        throw new Error("network blip mid-stream");
      },
    };
    stream.mockResolvedValueOnce(errorStream);
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    // First chunk = partial text, second = error sentinel, NO [DONE] because
    // the catch path emits error then closes (skips DONE).
    expect(data).toHaveLength(2);
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "partial" });
    expect(JSON.parse(data[1].slice(6))).toEqual({ error: "Stream error" });
  });
});

describe("Anthropic SDK error mapping", () => {
  it("AuthenticationError → 401 'API key invalid' (JSON, not SSE)", async () => {
    stream.mockRejectedValueOnce(new AnthropicMock.AuthenticationError("bad key"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("API key invalid");
  });

  it("RateLimitError → 429 'Too many requests'", async () => {
    stream.mockRejectedValueOnce(new AnthropicMock.RateLimitError("rate"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too many requests");
  });

  it("any other SDK error → 500 'Internal server error'; sentinel NOT leaked", async () => {
    stream.mockRejectedValueOnce(
      new Error("Network down — sa_key_LEAK_ME_PLEASE")
    );
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("sa_key_LEAK_ME_PLEASE");
  });
});
