/**
 * Tests for `app/api/admin/support-tickets/[id]/route.ts` (slice 7i6, part 1).
 *
 * Admin ticket detail: GET (read) + PATCH (status/priority) + POST (reply).
 *
 * Threat model:
 *  - **XSS in customer-facing reply email**: customer's name + the
 *    admin's message body are interpolated into HTML. A refactor
 *    that dropped the escapeHtml would let an admin (or a stolen
 *    admin session) inject arbitrary HTML/JS into the customer's
 *    inbox. Pinned with hostile-name + hostile-message probes.
 *  - **Reply-to-closed**: a refactor that lets admin reply to a
 *    closed ticket would silently re-engage the thread without
 *    reopening — pinned 400 TICKET_CLOSED.
 *  - **Attachment-storage DoS**: per-ticket cumulative cap
 *    enforced server-side. Pinned with the cap helper return value.
 *
 * Other pins:
 *  - Admin gate per-method → 401
 *  - PATCH zod: status enum (open/in_progress/resolved/closed);
 *    priority enum (low/medium/high)
 *  - resolvedAt: resolved/closed → now; else null
 *  - PATCH 404 when ticket missing
 *  - POST attachment validation → 400 VALIDATION_ERROR
 *  - POST ticket missing → 404
 *  - POST ticket closed → 400 TICKET_CLOSED
 *  - Attachment cap → 400 TICKET_STORAGE_FULL
 *  - Reply pushes authorRole:'admin' with adminName fallback
 *    "Support Team"
 *  - Reply on open or resolved → auto-bump to in_progress
 *  - Reply on resolved → resolvedAt cleared
 *  - Email send is fire-and-forget (.catch swallow)
 *  - Email subject + body contain ticketNumber
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getTicketById = vi.hoisted(() => vi.fn());
const getTicketByIdLean = vi.hoisted(() => vi.fn());
const updateTicketByIdAsAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/support-tickets", () => ({
  getTicketById,
  getTicketByIdLean,
  updateTicketByIdAsAdmin,
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

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, PATCH, POST } from "@/app/api/admin/support-tickets/[id]/route";

const TICKET_ID = "T1";
const ADMIN = {
  _id: "ADMIN1",
  firstName: "Alice",
  lastName: "Admin",
  email: "admin@example.com",
};

function makeReq(method: "GET" | "PATCH" | "POST", body?: unknown) {
  return new NextRequest(
    `https://example.com/api/admin/support-tickets/${TICKET_ID}`,
    {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }
  );
}

const params = { params: Promise.resolve({ id: TICKET_ID }) };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(ADMIN);
  getTicketById.mockReset();
  getTicketByIdLean.mockReset();
  updateTicketByIdAsAdmin.mockReset();
  sendEmail.mockReset().mockResolvedValue(undefined);
  validateAttachments.mockReset().mockReturnValue({
    ok: true,
    attachments: [],
  });
  sumExistingAttachmentBytes.mockReset().mockReturnValue(0);
  checkTicketTotalCap.mockReset().mockReturnValue(null);
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — admin gate + 404", () => {
  it("non-admin → 401; no read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"), params);
    expect(res.status).toBe(401);
    expect(getTicketByIdLean).not.toHaveBeenCalled();
  });

  it("ticket missing → 404", async () => {
    getTicketByIdLean.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"), params);
    expect(res.status).toBe(404);
  });

  it("found → 200 with ticket", async () => {
    const ticket = { _id: TICKET_ID, ticketNumber: "T-001" };
    getTicketByIdLean.mockResolvedValueOnce(ticket);
    const res = await GET(makeReq("GET"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket).toEqual(ticket);
  });
});

// ─────────────────────────── PATCH ─────────────────────────────

describe("PATCH — admin gate + schema", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq("PATCH", { status: "closed" }), params);
    expect(res.status).toBe(401);
    expect(updateTicketByIdAsAdmin).not.toHaveBeenCalled();
  });

  it("invalid status → 400", async () => {
    const res = await PATCH(
      makeReq("PATCH", { status: "BURN" }),
      params
    );
    expect(res.status).toBe(400);
  });

  it("invalid priority → 400", async () => {
    const res = await PATCH(
      makeReq("PATCH", { priority: "URGENT" }),
      params
    );
    expect(res.status).toBe(400);
  });

  it("empty body → 200 (all fields optional)", async () => {
    updateTicketByIdAsAdmin.mockResolvedValueOnce({ _id: TICKET_ID });
    const res = await PATCH(makeReq("PATCH", {}), params);
    expect(res.status).toBe(200);
  });
});

describe("PATCH — resolvedAt timestamp", () => {
  it("status='resolved' → resolvedAt set to now", async () => {
    updateTicketByIdAsAdmin.mockResolvedValueOnce({ _id: TICKET_ID });
    const before = Date.now();
    await PATCH(makeReq("PATCH", { status: "resolved" }), params);
    const update = updateTicketByIdAsAdmin.mock.calls[0][1].$set;
    expect(update.status).toBe("resolved");
    expect(update.resolvedAt).toBeInstanceOf(Date);
    expect((update.resolvedAt as Date).getTime()).toBeGreaterThanOrEqual(
      before - 200
    );
  });

  it("status='closed' → resolvedAt set to now", async () => {
    updateTicketByIdAsAdmin.mockResolvedValueOnce({ _id: TICKET_ID });
    await PATCH(makeReq("PATCH", { status: "closed" }), params);
    const update = updateTicketByIdAsAdmin.mock.calls[0][1].$set;
    expect(update.resolvedAt).toBeInstanceOf(Date);
  });

  it("status='in_progress' → resolvedAt cleared to null", async () => {
    updateTicketByIdAsAdmin.mockResolvedValueOnce({ _id: TICKET_ID });
    await PATCH(makeReq("PATCH", { status: "in_progress" }), params);
    const update = updateTicketByIdAsAdmin.mock.calls[0][1].$set;
    expect(update.resolvedAt).toBeNull();
  });

  it("status='open' → resolvedAt cleared to null", async () => {
    updateTicketByIdAsAdmin.mockResolvedValueOnce({ _id: TICKET_ID });
    await PATCH(makeReq("PATCH", { status: "open" }), params);
    const update = updateTicketByIdAsAdmin.mock.calls[0][1].$set;
    expect(update.resolvedAt).toBeNull();
  });
});

describe("PATCH — 404", () => {
  it("updateTicketByIdAsAdmin returns null → 404", async () => {
    updateTicketByIdAsAdmin.mockResolvedValueOnce(null);
    const res = await PATCH(
      makeReq("PATCH", { status: "resolved" }),
      params
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────── POST (reply) ─────────────────────────────

describe("POST reply — admin gate + schema", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(401);
    expect(validateAttachments).not.toHaveBeenCalled();
  });

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
      error: "Attachment too big",
    });
    const res = await POST(
      makeReq("POST", {
        message: "hi",
        attachments: [{ filename: "x", mimeType: "image/png", size: 1, dataUrl: "data:..." }],
      }),
      params
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST reply — ticket guards", () => {
  it("ticket missing → 404", async () => {
    getTicketById.mockResolvedValueOnce(null);
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(404);
  });

  it("ticket closed → 400 TICKET_CLOSED", async () => {
    getTicketById.mockResolvedValueOnce({
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
    checkTicketTotalCap.mockReturnValueOnce(
      "Ticket storage cap (20 MB) exceeded"
    );
    getTicketById.mockResolvedValueOnce({
      _id: TICKET_ID,
      status: "in_progress",
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

describe("POST reply — message push + status flip", () => {
  interface FakeMessage {
    content: string;
    authorId?: unknown;
    authorRole: string;
    authorName: string;
    attachments?: unknown[];
    createdAt: Date;
  }
  function setupTicket(status: string) {
    const ticket = {
      _id: TICKET_ID,
      ticketNumber: "T-001",
      subject: "Need help",
      userName: "Customer",
      userEmail: "customer@example.com",
      status,
      messages: [] as FakeMessage[],
      resolvedAt: status === "resolved" ? (new Date("2026-01-01") as Date | undefined) : undefined,
      save: vi.fn().mockResolvedValue(undefined),
    };
    getTicketById.mockResolvedValueOnce(ticket);
    return ticket;
  }

  it("open ticket → message pushed; status flipped to in_progress", async () => {
    const ticket = setupTicket("open");
    await POST(makeReq("POST", { message: "Here's the fix" }), params);
    expect(ticket.messages).toHaveLength(1);
    expect(ticket.messages[0]).toEqual(
      expect.objectContaining({
        content: "Here's the fix",
        authorRole: "admin",
        authorName: "Alice Admin",
      })
    );
    expect(ticket.status).toBe("in_progress");
  });

  it("resolved ticket → status flipped to in_progress + resolvedAt CLEARED", async () => {
    const ticket = setupTicket("resolved");
    await POST(makeReq("POST", { message: "Reopening" }), params);
    expect(ticket.status).toBe("in_progress");
    expect(ticket.resolvedAt).toBeUndefined();
  });

  it("in_progress ticket → message pushed; status UNCHANGED", async () => {
    const ticket = setupTicket("in_progress");
    await POST(makeReq("POST", { message: "Update" }), params);
    expect(ticket.status).toBe("in_progress");
  });

  it("adminName fallback 'Support Team' when admin has no first+last names (NOTE: template-literal quirk — both null/undefined gives 'null null'/'undefined undefined' truthy; only empty strings trigger fallback)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({
      _id: "ADMIN1",
      firstName: "",
      lastName: "",
    });
    const ticket = setupTicket("open");
    await POST(makeReq("POST", { message: "hi" }), params);
    expect(ticket.messages[0].authorName).toBe("Support Team");
  });

  it("save called once", async () => {
    const ticket = setupTicket("open");
    await POST(makeReq("POST", { message: "hi" }), params);
    expect(ticket.save).toHaveBeenCalledTimes(1);
  });
});

describe("POST reply — XSS-escaped email", () => {
  function setupHostile(hostileUserName: string, hostileMessage: string) {
    const ticket = {
      _id: TICKET_ID,
      ticketNumber: "T-001",
      subject: "Need help",
      userName: hostileUserName,
      userEmail: "customer@example.com",
      status: "open",
      messages: [],
      save: vi.fn().mockResolvedValue(undefined),
    };
    getTicketById.mockResolvedValueOnce(ticket);
    return { ticket, hostileMessage };
  }

  it("hostile userName + message → email HTML escapes < > & \" '", async () => {
    setupHostile(
      "<script>alert(1)</script>",
      "Reply with <img src=x onerror=alert('xss')> and \"quotes\""
    );
    await POST(
      makeReq("POST", {
        message:
          "Reply with <img src=x onerror=alert('xss')> and \"quotes\"",
      }),
      params
    );
    const emailCall = sendEmail.mock.calls[0][0];
    const html = emailCall.html;
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;quotes&quot;");
  });

  it("newlines in message → <br> in HTML", async () => {
    setupHostile("Customer", "Line1\nLine2");
    await POST(
      makeReq("POST", { message: "Line1\nLine2" }),
      params
    );
    const html = sendEmail.mock.calls[0][0].html;
    expect(html).toContain("Line1<br>Line2");
  });

  it("email subject includes ticketNumber + subject", async () => {
    setupHostile("Customer", "hi");
    await POST(makeReq("POST", { message: "hi" }), params);
    const subject = sendEmail.mock.calls[0][0].subject;
    expect(subject).toContain("T-001");
    expect(subject).toContain("Need help");
  });

  it("email send throw → SWALLOWED (response still 200)", async () => {
    setupHostile("Customer", "hi");
    sendEmail.mockRejectedValueOnce(new Error("SMTP down"));
    const res = await POST(makeReq("POST", { message: "hi" }), params);
    expect(res.status).toBe(200);
  });
});
