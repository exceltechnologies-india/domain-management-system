import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { findUserTicket, findUserTicketLean } from "@/lib/services/support-tickets";
import { EmailService } from "@/lib/email";
import {
  validateAttachments,
  sumExistingAttachmentBytes,
  checkTicketTotalCap,
} from "@/lib/support-attachments";
import { rateLimiters } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { id } = await params;
    await connectDB();

    const ticket = await findUserTicketLean(id, String(user._id));
    if (!ticket) return secureErrorResponse("Ticket not found", 404, "NOT_FOUND");

    return secureJsonResponse({ ticket });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { id } = await params;
    const body = await request.json();

    // User can only close their own ticket. Reopening / priority / category
    // changes remain admin-only — once the user closes, the existing UX
    // already directs them to open a new ticket for further help.
    if (body.status !== "closed") {
      return secureErrorResponse(
        "Only closing your ticket is supported.",
        400,
        "VALIDATION_ERROR"
      );
    }

    await connectDB();

    const ticket = await findUserTicket(id, String(user._id));
    if (!ticket) return secureErrorResponse("Ticket not found", 404, "NOT_FOUND");

    if (ticket.status === "closed") {
      return secureJsonResponse({ ticket });
    }

    ticket.status = "closed";
    ticket.resolvedAt = new Date();
    await ticket.save();

    const safeUserName = escapeHtml(ticket.userName);
    const safeUserEmail = escapeHtml(ticket.userEmail);
    EmailService.sendEmail({
      to: process.env.ADMIN_EMAIL ?? "sales@anutech.in",
      subject: `[Support] Ticket Closed by User: ${ticket.ticketNumber} — ${ticket.subject}`,
      html: `<p>The user has closed support ticket <strong>${ticket.ticketNumber}</strong>.</p>
<p><strong>User:</strong> ${safeUserName} (${safeUserEmail})</p>
<p><a href="${process.env.NEXTAUTH_URL}/admin/support-tickets/${id}">View ticket in admin panel</a></p>`,
    }).catch(() => {});

    serverLogger.info(
      `[support] User ${user._id} closed ticket ${ticket.ticketNumber}`
    );

    return secureJsonResponse({ ticket });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    // Per-user reply rate limit.
    const userIdStr = user._id.toString();
    const rl = await rateLimiters.supportReply.checkKey(`support_reply:${userIdStr}`);
    if (!rl.allowed) {
      serverLogger.warn(`[support] reply rate-limited for user ${userIdStr}`);
      return secureErrorResponse(
        "You've sent too many replies recently. Please try again later.",
        429,
        "RATE_LIMITED"
      );
    }

    const { id } = await params;
    const { message, attachments } = await request.json();

    if (!message?.trim()) return secureErrorResponse("Message is required", 400, "VALIDATION_ERROR");
    if (message.length > 5000) return secureErrorResponse("Message too long", 400, "VALIDATION_ERROR");

    const attachmentResult = validateAttachments(attachments, {
      userId: userIdStr,
      route: "user.reply",
    });
    if (!attachmentResult.ok) {
      return secureErrorResponse(attachmentResult.error, 400, "VALIDATION_ERROR");
    }

    await connectDB();

    const ticket = await findUserTicket(id, String(user._id));
    if (!ticket) return secureErrorResponse("Ticket not found", 404, "NOT_FOUND");
    if (ticket.status === "closed") return secureErrorResponse("Ticket is closed", 400, "TICKET_CLOSED");

    // Per-ticket cumulative cap so a single thread can't be inflated to
    // arbitrary size through many small replies (MongoDB doc limit safety).
    if (attachmentResult.attachments.length > 0) {
      const existingBytes = sumExistingAttachmentBytes(ticket.messages);
      const capErr = checkTicketTotalCap(existingBytes, attachmentResult.attachments);
      if (capErr) return secureErrorResponse(capErr, 400, "TICKET_STORAGE_FULL");
    }

    ticket.messages.push({
      content: message.trim(),
      authorId: user._id,
      authorRole: "user",
      authorName: `${user.firstName} ${user.lastName}`.trim(),
      attachments: attachmentResult.attachments,
      createdAt: new Date(),
    });

    if (ticket.status === "resolved") {
      ticket.status = "open";
      ticket.resolvedAt = undefined;
    }
    await ticket.save();

    // Notify admin that user has replied — escape user-supplied content.
    const safeUserName = escapeHtml(ticket.userName);
    const safeUserEmail = escapeHtml(ticket.userEmail);
    const safeMessageHtml = escapeHtml(message.trim()).replace(/\n/g, "<br>");
    EmailService.sendEmail({
      to: process.env.ADMIN_EMAIL ?? "sales@anutech.in",
      subject: `[Support] User Reply: ${ticket.ticketNumber} — ${ticket.subject}`,
      html: `<p>The user has replied to support ticket <strong>${ticket.ticketNumber}</strong>.</p>
<p><strong>From:</strong> ${safeUserName} (${safeUserEmail})</p>
<blockquote style="border-left:4px solid #e5e7eb;padding-left:12px;color:#374151;">${safeMessageHtml}</blockquote>
${attachmentResult.attachments.length > 0 ? `<p><strong>Attachments:</strong> ${attachmentResult.attachments.length} image(s).</p>` : ""}
<p><a href="${process.env.NEXTAUTH_URL}/admin/support-tickets/${id}">View ticket in admin panel</a></p>`,
    }).catch(() => {});

    return secureJsonResponse({ ticket });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
