import { NextRequest, NextResponse } from "next/server";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { validatedBody, z } from "@/lib/api-validation";

// Zod gates: array shape + per-message role enum + bounded content length.
// `.slice(-20)` below keeps the conversation history bounded for cost.
const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000),
});

const chatSchema = z.object({
  messages: z.array(chatMessageSchema).min(1, "Invalid messages"),
});

const SYSTEM_PROMPT = `You are a helpful assistant for Anutech Digital Private Limited, a domain registration and web hosting company in India.

You help customers with:
- Domain registration: searching for available domains, pricing, extensions (.com, .in, .org, .net, 100+ TLDs)
- Domain management: DNS settings, nameservers, WHOIS privacy, domain transfers, renewals
- Web hosting: plans, Google Cloud-backed infrastructure, DirectAdmin control panel, features
- Account and billing: Razorpay payment options (cards, UPI, net banking), invoices
- Technical support: SSL certificates, email hosting, WordPress installation

Keep responses concise and friendly. For complex issues, suggest contacting support at support@anutech.in or calling the support team.
Do not make up specific pricing — tell users to check the website for current pricing.
Do not handle payments or access account data directly.`;

// Pinned to gemini-2.5-flash (Google AI Studio free-tier model). The model
// name itself is the stable identifier — Google's "-latest" aliases are
// what we'd want to avoid. Bump deliberately when the next Flash tier
// ships and is verified compatible.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function POST(req: NextRequest) {
  try {
    // SECURITY: cap per-IP usage so a single abuser can't drain the
    // Gemini free-tier quota. 10 req/min/IP keeps the endpoint usable
    // for legitimate pre-sales visitors. Anonymous-friendly intentionally —
    // no auth requirement.
    const rl = await rateLimiters.chat.isAllowed(req);
    if (!rl.allowed) {
      return rateLimitResponse(rl, {
        limit: 10,
        message: "Too many requests. Please slow down and try again in a minute.",
      });
    }

    const validation = await validatedBody(req, chatSchema);
    if (!validation.ok) return validation.response;
    // Keep the last 20 turns to bound token cost; Zod already guaranteed
    // the role + content shapes, so no per-element filter is needed.
    const sanitized = validation.data.messages.slice(-20);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "API key invalid" }, { status: 401 });
    }

    // Map our schema (user|assistant) to Gemini's contents shape (user|model).
    const contents = sanitized.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    // `alt=sse` makes Gemini emit standard `data: {...}\n\n` SSE frames
    // we can stream-parse without an SDK dependency.
    const upstream = await fetch(
      `${GEMINI_BASE}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { maxOutputTokens: 1024 },
        }),
      }
    );

    if (!upstream.ok) {
      // 401/403 from Gemini means the API key isn't valid for this project.
      // 429 means we've hit the free-tier rate / token quota.
      if (upstream.status === 401 || upstream.status === 403) {
        return NextResponse.json({ error: "API key invalid" }, { status: 401 });
      }
      if (upstream.status === 429) {
        return NextResponse.json({ error: "Too many requests" }, { status: 429 });
      }
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!upstream.body) {
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();

    const readable = new ReadableStream({
      async start(controller) {
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE frames are separated by a blank line (double newline).
            let nl;
            while ((nl = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 2);
              for (const line of frame.split("\n")) {
                if (!line.startsWith("data:")) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === "[DONE]") continue;
                let obj: unknown;
                try {
                  obj = JSON.parse(payload);
                } catch {
                  // Malformed payload from Gemini — skip the chunk
                  continue;
                }
                const parts =
                  (obj as {
                    candidates?: Array<{
                      content?: { parts?: Array<{ text?: string }> };
                    }>;
                  })?.candidates?.[0]?.content?.parts ?? [];
                for (const part of parts) {
                  if (typeof part?.text === "string" && part.text.length > 0) {
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ text: part.text })}\n\n`
                      )
                    );
                  }
                }
              }
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`)
          );
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
