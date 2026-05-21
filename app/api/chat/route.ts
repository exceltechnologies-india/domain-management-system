import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

export async function POST(req: NextRequest) {
  try {
    // SECURITY: cap per-IP usage so a single abuser can't drain the
    // Anthropic budget. 10 req/min/IP keeps the endpoint usable for
    // legitimate pre-sales visitors. Anonymous-friendly intentionally —
    // no auth requirement.
    const rl = await rateLimiters.chat.isAllowed(req);
    if (!rl.allowed) {
      return rateLimitResponse(rl, {
        limit: 10,
        message: "Too many requests. Please slow down and try again in a minute.",
      });
    }

    const { messages } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "Invalid messages" }, { status: 400 });
    }

    const sanitized = messages
      .filter(
        (m: unknown) =>
          m &&
          typeof m === "object" &&
          "role" in (m as object) &&
          "content" in (m as object) &&
          typeof (m as { role: unknown }).role === "string" &&
          typeof (m as { content: unknown }).content === "string"
      )
      .slice(-20) // keep last 20 turns
      .map((m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    if (sanitized.length === 0) {
      return NextResponse.json({ error: "No valid messages" }, { status: 400 });
    }

    const stream = await client.messages.stream({
      // Pinned to the dated Haiku 4.5 release (2025-10-01) so a future alias
      // re-point doesn't change the chat persona or token-spend profile.
      // Bump deliberately when the next Haiku tier ships.
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          // Cache the system prompt — it never changes between requests
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: sanitized,
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`)
              );
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
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "API key invalid" }, { status: 401 });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
