/**
 * Tests for `app/api/user/support/[id]/route.ts` (slice 7i6, part 2).
 *
 * Customer support-ticket detail: GET + PATCH (close-only) + POST reply.
 *
 * Threat model:
 *  - **Cross-tenant ticket peek/reply**: a customer must NOT be able
 *    to read/close/reply to another customer's ticket. Pinned via
 *    `findUserTicket(id, user._id)` keyed on session user ID.
 *  - **Customer privilege escalation via PATCH**: customer should
 *    only be able to CLOSE their own ticket — not reopen, prioritise,
 *    re-categorise, etc. Pinned: PATCH zod is `z.literal("closed")`;
 *    any other status → 400.
 *  - **Reply-storm DoS**: per-user rate limit on the reply path.
 *
 * Other pins:
 *  - Auth gate per-method → 401
 *  - GET 404 when ticket missing/not yours
 *  - PATCH close: idempotent if already closed (returns ticket
 *    unchanged)
 *  - PATCH close: sets status='closed', resolvedAt=now, save
 *  - PATCH close emails ADMIN_EMAIL with escaped user name + email
 *  - POST rate-limit denied → 429
 *  - POST validateAttachments fail → 400 VALIDATION_ERROR
 *  - POST 404 when ticket missing
 *  - POST closed → 400 TICKET_CLOSED
 *  - POST cap exceeded → 400 TICKET_STORAGE_FULL
 *  - POST resolved ticket → reopened to 'open' with resolvedAt cleared
 *  - POST email to admin with escapeHtml + <br> conversion
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findUserTicket = vi.hoisted(() => vi.fn());
const findUserTicketLean = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/support-tickets", () => ({
  findUserTicket,
  findUserTicketLean,
}));

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendEmail },
}));

const validateAttachments = vi.hoisted(() => vi.fn());
const sumExistingAttachmentBytes = vi.hoisted(() => vi.fn());
const checkTicketTotalCap = vi.hoisted(() => vi.fn());
vi.mock("@/lib/support-attachments", () => ({
  validateAttachments,
  sumExistingAttachmentBytes,
  checkTicketTotalCap,
}));

const checkKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return {
    ...actual,
    rateLimiters: { supportReply: { checkKey } },
  };
});

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, PATCH, POST } from "@/app/api/user/support/[id]/route";

const TICKET_ID = "T1";
const USER = {
  _id: "U1",
  firstName: "Alice",
  lastName: "Smith",
  email: "alice@example.com",
  toString: () => "U1",
};

function makeReq(method: "GET" | "PATCH" | "POST", body?: unknown) {
  return new NextRequest(
    `https://example.com/api/user/support/${TICKET_ID}`,
    {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }
  );
}

const params = { params: Promise.resolve({ id: TICKET_ID }) };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue({
    ...USER,
    _id: { toString: () => "U1" },
  });
  findUserTicket.mockReset();
  findUserTicketLean.mockReset();
  sendEmail.mockReset().mockResolvedValue(undefined);
  validateAttachments.mockReset().mockReturnValue({
    ok: true,
    attachments: [],
  });
  sumExistingAttachmentBytes.mockReset().mockReturnValue(0);
  checkTicketTotalCap.mockReset().mockReturnValue(null);
  checkKey.mockReset().mockResolvedValue({ allowed: true });
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — auth gate + IDOR scope", () => {
  it("no user → 401; no DB read", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"), params);
    expect(res.status).toBe(401);
    expect(findUserTicketLean).not.toHaveBeenCalled();
  });

  it("findUserTicketLean keyed on session user._id (anti-IDOR)", async () => {
    findUserTicketLean.mockResolvedValueOnce(null);
    await GET(makeReq("GET"), params);
    expect(findUserTicketLean).toHaveBeenCalledWith(TICKET_ID, "U1");
  });

  it("ticket missing → 404", async () => {
    findUserTicketLean.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"), params);
    expect(res.status).toBe(404);
  });

  it("found → 200 with ticket", async () => {
    const ticket = { _id: TICKET_ID, ticketNumber: "T-001" };
    findUserTicketLean.mockResolvedValueOnce(ticket);
    const res = await GET(makeReq("GET"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket).toEqual(ticket);
  });
});

// ─────────────────────────── PATCH (close-only) ─────────────────────────────

describe("PATCH close — auth + privilege guards", () => {
  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq("PATCH", { status: "closed" }), params);
    expect(res.status).toBe(401);
    expect(findUserTicket).not.toHaveBeenCalled();
  });

  it("**status='open' → 400 (only 'closed' allowed for customer)**", async () => {
    const res = await PATCH(makeReq("PATCH", { status: "open" }), params);
    expect(res.status).toBe(400);
    expect(findUserTicket).not.toHaveBeenCalled();
  });

  it("**status='in_progress' → 400** (customer cannot bump status)", async () => {
    const res = await PATCH(
      makeReq("PATCH", { status: "in_progress" }),
      params
    );
    expect(res.status).toBe(400);
  });

  it("**status='resolved' → 400** (customer cannot resolve)", async () => {
    const res = await PATCH(
      makeReq("PATCH", { status: "resolved" }),
      params
    );
    expect(res.status).toBe(400);
  });

  it("missing status → 400", async () => {
    const res = await PATCH(makeReq("PATCH", {}), params);
    expect(res.status).toBe(400);
  });

  it("extra body field 'priority' silently ignored (zod only validates declared fields)", async () => {
    // PATCH zod schema is `{ status: z.literal("closed") }` — extra
    // fields like `priority` are silently dropped (not .strict()),
    // so the request proceeds. Pinned at current behaviour — a
    // future hardening pass adding .strict() would flip this.
    const ticket = {
      _id: TICKET_ID,
      ticketNumber: "T-001",
      subject: "Help",
      userName: "Alice",
      userEmail: "a@b.com",
      status: "open",
      save: vi.fn().mockResolvedValue(undefined),
    };
    findUserTicket.mockResolvedValueOnce(ticket);
    const res = await PATCH(
      makeReq("PATCH", { status: "closed", priority: "high" }),
      params
    );
    expect(res.status).toBe(200);
    // Priority is NOT pushed to the ticket
    expect((ticket as { priority?: string }).priority).toBeUndefined();
  });
});

describe("PATCH close — IDOR scope + idempotency", () => {
  it("findUserTicket keyed on session user._id", async () => {
    findUserTicket.mockResolvedValueOnce(null);
    await PATCH(makeReq("PATCH", { status: "closed" }), params);
    expect(findUserTicket).toHaveBeenCalledWith(TICKET_ID, "U1");
  });

  it("ticket missing → 404", async () => {
    findUserTicket.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq("PATCH", { status: "closed" }), params);
    expect(res.status).toBe(404);
  });

  it("**already closed → idempotent; ticket returned, NO save, NO email**", async () => {
    const ticket = {
      _id: TICKET_ID,
      status: "closed",
      userName: "Alice",
      userEmail: "a@b.com",
      save: vi.fn(),
    };
    findUserTicket.mockResolvedValueOnce(ticket);
    const res = await PATCH(makeReq("PATCH", { status: "closed" }), params);
    expect(res.status).toBe(200);
    expect(ticket.save).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("open → close: status='closed', resolvedAt=now, save called, admin emailed", async () => {
    const ticket: {
      _id: string;
      ticketNumber: string;
      subject: string;
      userName: string;
      userEmail: string;
      status: string;
      resolvedAt?: Date;
      save: ReturnType<typeof vi.fn>;
    } = {
      _id: TICKET_ID,
      ticketNumber: "T-001",
      subject: "Help",
      userName: "Alice",
      userEmail: "alice@example.com",
      status: "open",
      save: vi.fn().mockResolvedValue(undefined),
    };
    findUserTicket.mockResolvedValueOnce(ticket);
    const before = Date.now();
    const res = await PATCH(makeReq("PATCH", { status: "closed" }), params);
    expect(res.status).toBe(200);
    expect(ticket.status).toBe("closed");
    expect(ticket.resolvedAt).toBeInstanceOf(Date);
    expect(ticket.resolvedAt!.getTime()).toBeGreaterThanOrEqual(
      before - 200
    );
    expect(ticket.save).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("PATCH close email — admin notified with escaped user fields", async () => {
    const ticket = {
      _id: TICKET_ID,
      ticketNumber: "T-001",
      subject: "Help",
      userName: "<script>Alice</script>",
      userEmail: "alice@example.com",
      status: "open",
      save: vi.fn().mockResolvedValue(undefined),
    };
    findUserTicket.mockResolvedValueOnce(ticket);
    await PATCH(makeReq("PATCH", { status: "closed" }), params);
    const emailCall = sendEmail.mock.calls[0][0];
    expect(emailCall.html).not.toContain("<script>Alice</script>");
    expect(emailCall.html).toContain("&lt;script&gt;");
    expect(emailCall.subject).toContain("T-001");
  });
});

// ─────────────────────────── POST (reply) ─────────────────────────────

describe("POST reply — auth + rate limit", () => {
  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(401);
    expect(checkKey).not.toHaveBeenCalled();
  });

  it("rate-limit denied → 429", async () => {
    checkKey.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(429);
    expect(findUserTicket).not.toHaveBeenCalled();
  });

  it("rate-limit key per-user 'support_reply:${userId}'", async () => {
    findUserTicket.mockResolvedValueOnce(null);
    await POST(makeReq("POST", { message: "hi" }), params);
    expect(checkKey).toHaveBeenCalledWith("support_reply:U1");
  });
});

describe("POST reply — schema + ticket guards", () => {
  it("missing message → 400", async () => {
    const res = await POST(makeReq("POST", {}), params);
    expect(res.status).toBe(400);
  });

  it("message > 5000 chars → 400", async () => {
    const res = await POST(
      makeReq("POST", { message: "x".repeat(5001) }),
      params
    );
    expect(res.status).toBe(400);
  });

  it("attachment validation fail → 400 VALIDATION_ERROR", async () => {
    validateAttachments.mockReturnValueOnce({
      ok: false,
      error: "Attachment magic-byte mismatch",
    });
    const res = await POST(
      makeReq("POST", {
        message: "hi",
        attachments: [{ filename: "x", mimeType: "image/png", size: 1, dataUrl: "d" }],
      }),
      params
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("ticket missing → 404", async () => {
    findUserTicket.mockResolvedValueOnce(null);
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(404);
  });

  it("ticket closed → 400 TICKET_CLOSED", async () => {
    findUserTicket.mockResolvedValueOnce({
      _id: TICKET_ID,
      status: "closed",
      messages: [],
    });
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("TICKET_CLOSED");
  });

  it("attachment cap exceeded → 400 TICKET_STORAGE_FULL", async () => {
    validateAttachments.mockReturnValueOnce({
      ok: true,
      attachments: [{ filename: "x", size: 1000 }],
    });
    checkTicketTotalCap.mockReturnValueOnce("Storage cap exceeded");
    findUserTicket.mockResolvedValueOnce({
      _id: TICKET_ID,
      status: "open",
      messages: [],
      save: vi.fn(),
    });
    const res = await POST(
      makeReq("POST", {
        message: "hi",
        attachments: [{ filename: "x", mimeType: "image/png", size: 1000, dataUrl: "d" }],
      }),
      params
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("TICKET_STORAGE_FULL");
  });
});

describe("POST reply — IDOR scope + message push", () => {
  function setupTicket(status: string) {
    const ticket = {
      _id: TICKET_ID,
      ticketNumber: "T-001",
      subject: "Need help",
      userName: "Alice Smith",
      userEmail: "alice@example.com",
      status,
      messages: [],
      resolvedAt:
        status === "resolved" ? new Date("2026-01-01") : undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    findUserTicket.mockResolvedValueOnce(ticket);
    return ticket;
  }

  it("findUserTicket keyed on session user._id (anti-IDOR)", async () => {
    findUserTicket.mockResolvedValueOnce(null);
    await POST(makeReq("POST", { message: "hi" }), params);
    expect(findUserTicket).toHaveBeenCalledWith(TICKET_ID, "U1");
  });

  it("open ticket → message pushed with authorRole:'user'", async () => {
    const ticket = setupTicket("open");
    await POST(makeReq("POST", { message: "My update" }), params);
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toEqual(
      expect.objectContaining({
        content: "My update",
        authorRole: "user",
        authorName: "Alice Smith",
      })
    );
    expect(ticket.save).toHaveBeenCalledTimes(1);
  });

  it("**resolved ticket → REOPENED to 'open' + resolvedAt cleared**", async () => {
    const ticket = setupTicket("resolved");
    await POST(makeReq("POST", { message: "Still broken" }), params);
    expect(ticket.status).toBe("open");
    expect(ticket.resolvedAt).toBeUndefined();
  });

  it("in_progress ticket → message pushed; status UNCHANGED", async () => {
    const ticket = setupTicket("in_progress");
    await POST(makeReq("POST", { message: "Update" }), params);
    expect(ticket.status).toBe("in_progress");
  });
});

describe("POST reply — admin email with escaping", () => {
  function setupHostile(name: string, email: string, message: string) {
    const ticket = {
      _id: TICKET_ID,
      ticketNumber: "T-001",
      subject: "Need help",
      userName: name,
      userEmail: email,
      status: "open",
      messages: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    findUserTicket.mockResolvedValueOnce(ticket);
    return { ticket, message };
  }

  it("hostile name + email + message → all escaped in admin email", async () => {
    setupHostile(
      "<script>Alice</script>",
      "alice@<evil>.com",
      "<img src=x onerror=alert(1)>"
    );
    await POST(
      makeReq("POST", { message: "<img src=x onerror=alert(1)>" }),
      params
    );
    const html = sendEmail.mock.calls[0][0].html;
    expect(html).not.toContain("<script>Alice");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("newlines in message → <br> in admin HTML", async () => {
    setupHostile("Alice", "a@b.com", "Line1\nLine2");
    await POST(
      makeReq("POST", { message: "Line1\nLine2" }),
      params
    );
    const html = sendEmail.mock.calls[0][0].html;
    expect(html).toContain("Line1<br>Line2");
  });

  it("subject contains ticketNumber + subject", async () => {
    setupHostile("Alice", "a@b.com", "hi");
    await POST(makeReq("POST", { message: "hi" }), params);
    expect(sendEmail.mock.calls[0][0].subject).toContain("T-001");
    expect(sendEmail.mock.calls[0][0].subject).toContain("Need help");
  });

  it("email send throw → SWALLOWED (response still 200)", async () => {
    setupHostile("Alice", "a@b.com", "hi");
    sendEmail.mockRejectedValueOnce(new Error("SMTP down"));
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(200);
  });
});
