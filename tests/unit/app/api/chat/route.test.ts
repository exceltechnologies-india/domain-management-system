/**
 * Tests for `app/api/chat/route.ts` (slice 7i2 → migrated to Gemini).
 *
 * Public AI chat widget. Anonymous, rate-limited, SSE-streamed.
 * Originally Anthropic Claude Haiku; switched to Google Gemini 2.5
 * Flash on 2026-06-16 (free-tier API key, project "anutech-hosting").
 *
 * Threat model:
 *  - **Budget-drain abuse**: a single hostile IP could otherwise
 *    flood the upstream and drain the free-tier quota. Pinned:
 *    10 requests per IP per minute BEFORE body parse (so a hostile
 *    large body can't even reach the JSON parser when throttled).
 *  - **Model-alias re-point cost shift**: a future Google alias
 *    redirect (e.g. `gemini-2.5-flash` → a paid tier) would silently
 *    change the per-conversation cost. Pinned to the exact model
 *    name in the request URL.
 *  - **Conversation-history token bomb**: a refactor that drops the
 *    `.slice(-20)` cost-bound would let clients send 1000-turn
 *    histories and burn quota. Pinned with a 25-message probe
 *    asserting only the last 20 reach the upstream.
 *  - **API-key leak via response error**: a refactor that bubbled
 *    Gemini's raw error body into our JSON response would leak the
 *    key. Pinned: outer-catch returns the generic message only.
 *
 * Other pins:
 *  - Rate-limit BEFORE body parse
 *  - zod: messages array min:1; role enum 'user'|'assistant';
 *    content 1-8000 chars
 *  - SSE Content-Type / Cache-Control: no-cache / Connection: keep-alive
 *  - Gemini SSE `data:` frames → our `data: {text}\n\n` chunks
 *  - Non-text candidate parts filtered out
 *  - `data: [DONE]\n\n` sentinel at end
 *  - System prompt sent via `systemInstruction.parts[0].text`
 *  - Generation config max_output_tokens: 1024 pinned
 *  - Role mapping: our 'assistant' → Gemini's 'model'
 *  - Gemini error mapping: 401/403 → 401 'API key invalid'; 429 →
 *    429 'Too many requests'; other → 500 'Internal server error'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.GEMINI_API_KEY = "test_gemini_key_xyz";
});

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

/**
 * Build a fake upstream Gemini SSE response. Each frame is one
 * candidate-content blob; the route should parse them into our
 * `data: {text}\n\n` chunks. We use a TransformStream-style
 * ReadableStream so the route's reader.read() loop sees the bytes.
 */
function makeGeminiStream(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Build the SSE frame body that wraps a single text chunk. */
function textCandidate(text: string): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  })}\n\n`;
}

/** Build a frame with a non-text part (should be skipped). */
function nonTextCandidate(): string {
  return `data: ${JSON.stringify({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "lookup", args: {} } }],
        },
      },
    ],
  })}\n\n`;
}

function jsonErrorResponse(status: number, message = "Upstream error"): Response {
  return new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

const fetchMock = vi.fn();

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true, remaining: 10 });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

// ═══════════════════════════════════════════════════════════════════
// Rate limit BEFORE body parse
// ═══════════════════════════════════════════════════════════════════
describe("Rate-limit BEFORE body parse (anti-budget-drain)", () => {
  it("denied → 429; body NEVER parsed; upstream NEVER called", async () => {
    isAllowed.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    // Hostile body bytes — if rate-limit ran after parse, this would 400.
    const res = await POST(makeReq("{not-json"));
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// zod schema validation
// ═══════════════════════════════════════════════════════════════════
describe("Zod schema", () => {
  it("empty messages array → 400 (min:1)", async () => {
    const res = await POST(makeReq({ messages: [] }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
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

// ═══════════════════════════════════════════════════════════════════
// Conversation history cost-bound
// ═══════════════════════════════════════════════════════════════════
describe("Conversation history cost-bound (.slice(-20))", () => {
  it("25 messages sent → only last 20 reach the upstream", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    }));
    await POST(makeReq({ messages }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents).toHaveLength(20);
    // Oldest of the last 20 = msg-5
    expect(body.contents[0].parts[0].text).toBe("msg-5");
    expect(body.contents[19].parts[0].text).toBe("msg-24");
  });

  it("3 messages → all 3 reach the upstream (no truncation)", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(
      makeReq({
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Gemini upstream call shape
// ═══════════════════════════════════════════════════════════════════
describe("Gemini upstream call shape", () => {
  it("**model pinned to `gemini-2.5-flash` in the URL** (anti-alias-repoint)", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(makeReq(VALID));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/models/gemini-2.5-flash:streamGenerateContent");
  });

  it("URL carries `alt=sse` for standard SSE framing", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(makeReq(VALID));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("alt=sse");
  });

  it("API key passed via `key=` query param", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(makeReq(VALID));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("key=test_gemini_key_xyz");
  });

  it("missing GEMINI_API_KEY env var → 401 'API key invalid' (NO upstream call)", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const res = await POST(makeReq(VALID));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("API key invalid");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.GEMINI_API_KEY = saved;
    }
  });

  it("max_output_tokens: 1024 pinned", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(makeReq(VALID));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
  });

  it("system prompt sent via systemInstruction.parts[0].text + contains 'Anutech'", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(makeReq(VALID));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.systemInstruction.parts[0].text).toContain("Anutech");
  });

  it("role mapping: our 'assistant' → Gemini's 'model'; 'user' stays 'user'", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(
      makeReq({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "yo" },
          { role: "user", content: "again" },
        ],
      })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual([
      "user",
      "model",
      "user",
    ]);
  });

  it("Content-Type request header set to application/json", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    await POST(makeReq(VALID));
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers["Content-Type"]).toBe("application/json");
  });
});

// ═══════════════════════════════════════════════════════════════════
// SSE streaming response
// ═══════════════════════════════════════════════════════════════════
describe("SSE streaming response", () => {
  it("Content-Type: text/event-stream + Cache-Control: no-cache + Connection: keep-alive", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  it("Gemini text chunks → `data: {text}\\n\\n` chunks; ends with `[DONE]`", async () => {
    fetchMock.mockResolvedValueOnce(
      makeGeminiStream([textCandidate("Hello "), textCandidate("world!")])
    );
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(data).toHaveLength(3);
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "Hello " });
    expect(JSON.parse(data[1].slice(6))).toEqual({ text: "world!" });
    expect(data[2]).toBe("data: [DONE]");
  });

  it("non-text parts (e.g. functionCall) filtered out — never emitted as text chunks", async () => {
    fetchMock.mockResolvedValueOnce(
      makeGeminiStream([nonTextCandidate(), textCandidate("real text")])
    );
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(data).toHaveLength(2); // text + DONE
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "real text" });
  });

  it("empty stream → only the `[DONE]` sentinel emitted", async () => {
    fetchMock.mockResolvedValueOnce(makeGeminiStream([]));
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(data).toEqual(["data: [DONE]"]);
  });

  it("upstream `[DONE]` sentinel is consumed (not re-emitted as text)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeGeminiStream([textCandidate("hi"), "data: [DONE]\n\n"])
    );
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    // One real text + our own [DONE] sentinel = 2
    expect(data).toHaveLength(2);
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "hi" });
    expect(data[1]).toBe("data: [DONE]");
  });

  it("malformed upstream JSON in a frame → chunk skipped, stream continues", async () => {
    fetchMock.mockResolvedValueOnce(
      makeGeminiStream([
        textCandidate("good "),
        "data: {NOT-VALID-JSON\n\n",
        textCandidate("more good"),
      ])
    );
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(data).toHaveLength(3);
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "good " });
    expect(JSON.parse(data[1].slice(6))).toEqual({ text: "more good" });
    expect(data[2]).toBe("data: [DONE]");
  });

  it("split frame across reader.read() boundaries reassembles correctly", async () => {
    // Slice a single SSE frame in the middle so the buffer-join code is exercised.
    const frame = textCandidate("hello world");
    const mid = Math.floor(frame.length / 2);
    fetchMock.mockResolvedValueOnce(
      makeGeminiStream([frame.slice(0, mid), frame.slice(mid)])
    );
    const res = await POST(makeReq(VALID));
    const chunks = await readSSEChunks(res);
    const data = chunks.filter((c) => c.startsWith("data: "));
    expect(JSON.parse(data[0].slice(6))).toEqual({ text: "hello world" });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Stream error mid-flight
// ═══════════════════════════════════════════════════════════════════
describe("Stream error mid-flight", () => {
  it("reader throws → emits `data: {error: 'Stream error'}` then closes", async () => {
    // Use `pull` so the consumer's read() returns the queued chunk
    // BEFORE we error the stream on the next pull cycle. With a single
    // `start()` that enqueues + errors immediately, the consumer can
    // miss the queued chunk depending on scheduler timing.
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const encoder = new TextEncoder();
        if (pulls === 0) {
          pulls++;
          controller.enqueue(encoder.encode(textCandidate("partial")));
          return;
        }
        controller.error(new Error("network blip mid-stream"));
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })
    );
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

// ═══════════════════════════════════════════════════════════════════
// Upstream error mapping
// ═══════════════════════════════════════════════════════════════════
describe("Gemini upstream error mapping", () => {
  it("upstream 401 → 401 'API key invalid' (JSON, not SSE)", async () => {
    fetchMock.mockResolvedValueOnce(jsonErrorResponse(401, "INVALID_ARGUMENT"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("API key invalid");
  });

  it("upstream 403 → 401 'API key invalid' (anti-permission-disclosure)", async () => {
    fetchMock.mockResolvedValueOnce(jsonErrorResponse(403, "PERMISSION_DENIED"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("API key invalid");
  });

  it("upstream 429 → 429 'Too many requests'", async () => {
    fetchMock.mockResolvedValueOnce(jsonErrorResponse(429, "RESOURCE_EXHAUSTED"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too many requests");
  });

  it("upstream 500 → 500 'Internal server error'", async () => {
    fetchMock.mockResolvedValueOnce(jsonErrorResponse(500, "INTERNAL"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("fetch throw (network down) → 500 'Internal server error'; sentinel NOT leaked", async () => {
    fetchMock.mockRejectedValueOnce(
      new Error("Network down — sa_key_LEAK_ME_PLEASE")
    );
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("sa_key_LEAK_ME_PLEASE");
  });

  it("upstream with no body → 500 generic", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    );
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
  });

  it("upstream error body NOT leaked into the response (sentinel-leak guard)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "API key AQ.LEAK_ME_PLEASE is revoked" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    );
    const res = await POST(makeReq(VALID));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("LEAK_ME_PLEASE");
    expect(JSON.stringify(body)).not.toContain("AQ.");
  });
});
