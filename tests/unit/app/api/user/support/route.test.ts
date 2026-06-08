/**
 * Tests for `app/api/user/support/route.ts` (slice 7gl). Customer
 * support-ticket GET (list) + POST (create) endpoints.
 *
 * Security concerns pinned:
 *   1. **IDOR**: GET list scoped on user._id (no cross-user reads)
 *   2. **Stored XSS in admin inbox**: every user-typed field
 *      (subject, message, userName, userEmail) is escapeHtml'd
 *      BEFORE interpolation into the admin notification email's
 *      HTML body. Admin reads tickets in webmail; an unescaped
 *      <script>/<img onerror> would fire there.
 *   3. **Per-user rate limit** = 5 tickets / hr keyed on
 *      `support_create:${userId}` — anti-spam / anti-abuse
 *   4. **Attachment validation** must run BEFORE createSupportTicket
 *      so malicious files don't reach the DB
 *
 * Specific pins:
 *  - GET: auth gate FIRST → 401 UNAUTHORIZED; listTicketsForUserSummary
 *    scoped on String(user._id); response { tickets }; throw → 500
 *    SERVER_ERROR
 *  - POST: auth gate FIRST → 401; rate-limit BEFORE body parsing
 *    (over limit → rateLimitResponse with the "too many tickets"
 *    message; NO body validation, NO ticket create, NO email)
 *  - zod schema: subject 1-200 / message 1-5000 / category enum
 *    optional / attachments array optional
 *  - Category defaults to 'other' when omitted
 *  - validateAttachments runs BEFORE createSupportTicket; if it
 *    fails → 400 VALIDATION_ERROR with its error message (NO
 *    ticket created)
 *  - createSupportTicket call shape: userId, userEmail, userName,
 *    subject (trimmed), category, messages[0] with content
 *    (trimmed), authorRole 'user', validated attachments
 *  - **Admin email anti-XSS**: subject / userName / userEmail /
 *    message all HTML-escaped (&lt;script&gt; etc.); newlines in
 *    message converted to <br>
 *  - Admin email failure SWALLOWED via .catch(()=>{}) — ticket
 *    create must not be rolled back because of mailserver hiccup
 *  - 201 with { ticket } on success
 *  - Outer catch → 500 SERVER_ERROR
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const checkKey = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { supportCreate: { checkKey } },
  rateLimitResponse,
}));

const createSupportTicket = vi.hoisted(() => vi.fn());
const listTicketsForUserSummary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/support-tickets", () => ({
  createSupportTicket,
  listTicketsForUserSummary,
}));

const validateAttachments = vi.hoisted(() => vi.fn());
vi.mock("@/lib/support-attachments", () => ({ validateAttachments }));

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({ EmailService: { sendEmail } }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/user/support/route";

function makeGetReq() {
  return new NextRequest("https://example.com/api/user/support", {
    method: "GET",
  });
}

function makePostReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/support", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Anderson",
};

const validTicket = {
  subject: "Cannot access my account",
  message: "I'm locked out after the password reset.",
  category: "technical",
};

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  checkKey.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  createSupportTicket.mockReset();
  listTicketsForUserSummary.mockReset();
  validateAttachments.mockReset().mockReturnValue({
    ok: true,
    attachments: [],
  });
  sendEmail.mockReset().mockResolvedValue(undefined);
  process.env.ADMIN_EMAIL = "support-admin@example.com";
  process.env.NEXTAUTH_URL = "https://app.test";
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

// ─── GET — list ──────────────────────────────────────────────────
describe("GET — auth gate + IDOR scope", () => {
  it("no user → 401 UNAUTHORIZED", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
    expect(listTicketsForUserSummary).not.toHaveBeenCalled();
  });

  it("listTicketsForUserSummary called with String(user._id); response { tickets }", async () => {
    listTicketsForUserSummary.mockResolvedValueOnce([
      { ticketNumber: "T-1" },
      { ticketNumber: "T-2" },
    ]);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    expect(listTicketsForUserSummary).toHaveBeenCalledWith("U1");
    const body = await res.json();
    expect(body.tickets).toHaveLength(2);
  });

  it("service throw → 500 SERVER_ERROR", async () => {
    listTicketsForUserSummary.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeGetReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});

// ─── POST — auth + rate-limit gates ──────────────────────────────
describe("POST — auth + rate-limit gates", () => {
  it("no user → 401; NO rate-limit check", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makePostReq(validTicket));
    expect(res.status).toBe(401);
    expect(checkKey).not.toHaveBeenCalled();
  });

  it("rate-limit key shape: `support_create:${user._id}`", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-001",
      userName: "Alice Anderson",
      userEmail: "alice@example.com",
    });
    await POST(makePostReq(validTicket));
    expect(checkKey).toHaveBeenCalledWith("support_create:U1");
  });

  it("over rate limit → rateLimitResponse with 'too many tickets' message; NO body parse, NO ticket create, NO email", async () => {
    checkKey.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response("rate-limited", { status: 429 });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await POST(makePostReq(validTicket));
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      {
        message:
          "You've created too many tickets recently. Please try again later.",
      }
    );
    expect(createSupportTicket).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(validateAttachments).not.toHaveBeenCalled();
  });
});

// ─── POST — body validation ──────────────────────────────────────
describe("POST — body validation", () => {
  it("missing subject → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makePostReq({ message: "hi" }));
    expect(res.status).toBe(400);
    expect(createSupportTicket).not.toHaveBeenCalled();
  });

  it("subject > 200 chars → 400", async () => {
    const res = await POST(
      makePostReq({ ...validTicket, subject: "x".repeat(201) })
    );
    expect(res.status).toBe(400);
  });

  it("message > 5000 chars → 400", async () => {
    const res = await POST(
      makePostReq({ ...validTicket, message: "x".repeat(5001) })
    );
    expect(res.status).toBe(400);
  });

  it("invalid category enum → 400", async () => {
    const res = await POST(
      makePostReq({ ...validTicket, category: "totally-fake-category" })
    );
    expect(res.status).toBe(400);
  });

  it("category omitted → defaults to 'other'", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-001",
      userName: "Alice Anderson",
      userEmail: "alice@example.com",
    });
    await POST(
      makePostReq({ subject: "Help", message: "Stuck on login" })
    );
    expect(createSupportTicket).toHaveBeenCalledWith(
      expect.objectContaining({ category: "other" })
    );
  });
});

// ─── POST — attachment validation order ──────────────────────────
describe("POST — attachment validation runs BEFORE createSupportTicket", () => {
  it("validateAttachments failure → 400 VALIDATION_ERROR with its error message; NO ticket created", async () => {
    validateAttachments.mockReturnValueOnce({
      ok: false,
      error: "Attachment too large (> 2MB)",
    });
    const res = await POST(makePostReq(validTicket));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Attachment too large (> 2MB)");
    expect(createSupportTicket).not.toHaveBeenCalled();
  });

  it("validateAttachments called with userId + route label", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-001",
      userName: "Alice Anderson",
      userEmail: "alice@example.com",
    });
    await POST(makePostReq(validTicket));
    expect(validateAttachments).toHaveBeenCalledWith(undefined, {
      userId: "U1",
      route: "user.create-ticket",
    });
  });
});

// ─── POST — createSupportTicket call shape ───────────────────────
describe("POST — createSupportTicket call shape", () => {
  it("passes userId, userEmail, userName (trimmed), trimmed subject + message, resolved category, messages[0] shape", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-001",
      userName: "Alice Anderson",
      userEmail: "alice@example.com",
    });
    validateAttachments.mockReturnValueOnce({
      ok: true,
      attachments: [{ filename: "ok.png" }],
    });

    await POST(
      makePostReq({
        subject: "  My subject  ",
        message: "  My message  ",
        category: "billing",
      })
    );

    expect(createSupportTicket).toHaveBeenCalledWith({
      userId: "U1",
      userEmail: "alice@example.com",
      userName: "Alice Anderson",
      subject: "My subject",
      category: "billing",
      messages: [
        {
          content: "My message",
          authorId: "U1",
          authorRole: "user",
          authorName: "Alice Anderson",
          attachments: [{ filename: "ok.png" }],
        },
      ],
    });
  });
});

// ─── POST — Admin email anti-XSS ─────────────────────────────────
describe("POST — admin email anti-stored-XSS", () => {
  it("escapeHtml on subject / userName / userEmail / message — no raw <script> in HTML body", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-XSS",
      userName: '<script>alert("admin-xss")</script>Eve',
      userEmail: "evil@x.com",
    });

    await POST(
      makePostReq({
        subject: "<img onerror=alert(1)>Help!",
        message: "<b>bold</b> & quoted's <i>italics</i>",
        category: "technical",
      })
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const html = sendEmail.mock.calls[0][0].html as string;

    // No raw dangerous tags anywhere in the HTML body
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).not.toContain("<b>bold</b>");

    // Escaped forms present
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&#39;"); // apostrophe escaped
  });

  it("newlines in message become <br> AFTER escaping", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-NL",
      userName: "Alice",
      userEmail: "alice@example.com",
    });

    await POST(
      makePostReq({
        subject: "Line breaks",
        message: "line1\nline2\nline3",
        category: "other",
      })
    );

    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("line1<br>line2<br>line3");
  });

  it("admin email failure SWALLOWED — ticket create still returns 201", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-1",
      userName: "Alice Anderson",
      userEmail: "alice@example.com",
    });
    sendEmail.mockRejectedValueOnce(new Error("SMTP outage"));

    const res = await POST(makePostReq(validTicket));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ticket.ticketNumber).toBe("T-1");
  });

  it("admin email recipient comes from ADMIN_EMAIL env; ticket-number in subject; link to admin panel in body", async () => {
    process.env.ADMIN_EMAIL = "ops-alerts@example.com";
    createSupportTicket.mockResolvedValueOnce({
      _id: "TICKET_DOC_ID",
      ticketNumber: "T-42",
      userName: "Alice",
      userEmail: "alice@example.com",
    });

    await POST(makePostReq(validTicket));

    const call = sendEmail.mock.calls[0][0];
    expect(call.to).toBe("ops-alerts@example.com");
    expect(call.subject).toContain("T-42");
    expect(call.html).toContain(
      "https://app.test/admin/support-tickets/TICKET_DOC_ID"
    );
  });

  it("attachments count surfaced in admin email when > 0", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-1",
      userName: "Alice",
      userEmail: "alice@example.com",
    });
    validateAttachments.mockReturnValueOnce({
      ok: true,
      attachments: [{ filename: "a.png" }, { filename: "b.png" }],
    });

    await POST(makePostReq(validTicket));
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("2 image(s)");
  });

  it("attachments section absent when zero attachments", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-1",
      userName: "Alice",
      userEmail: "alice@example.com",
    });

    await POST(makePostReq(validTicket));
    const html = sendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("image(s)");
    expect(html).not.toContain("Attachments:");
  });
});

// ─── POST — success response shape ───────────────────────────────
describe("POST — success response shape", () => {
  it("201 with { ticket }", async () => {
    createSupportTicket.mockResolvedValueOnce({
      _id: "T1",
      ticketNumber: "T-001",
      userName: "Alice Anderson",
      userEmail: "alice@example.com",
      subject: "x",
    });

    const res = await POST(makePostReq(validTicket));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ticket.ticketNumber).toBe("T-001");
  });
});

// ─── POST — outer catch ──────────────────────────────────────────
describe("POST — outer catch", () => {
  it("createSupportTicket throw → 500 SERVER_ERROR (no leak)", async () => {
    createSupportTicket.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await POST(makePostReq(validTicket));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});
