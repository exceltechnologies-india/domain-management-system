import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { createSupportTicket, listTicketsForUserSummary } from "@/lib/services/support-tickets";
import { EmailService } from "@/lib/email";
import { validateAttachments } from "@/lib/support-attachments";
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

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const tickets = await listTicketsForUserSummary(String(user._id));

    return secureJsonResponse({ tickets });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    // Per-user rate limit — 5 new tickets per hour.
    const userIdStr = user._id.toString();
    const rl = await rateLimiters.supportCreate.checkKey(`support_create:${userIdStr}`);
    if (!rl.allowed) {
      serverLogger.warn(`[support] create rate-limited for user ${userIdStr}`);
      return secureErrorResponse(
        "You've created too many tickets recently. Please try again later.",
        429,
        "RATE_LIMITED"
      );
    }

    const body = await request.json();
    const { subject, category, message, attachments } = body;

    if (!subject?.trim()) return secureErrorResponse("Subject is required", 400, "VALIDATION_ERROR");
    if (!message?.trim()) return secureErrorResponse("Message is required", 400, "VALIDATION_ERROR");
    if (subject.length > 200) return secureErrorResponse("Subject too long (max 200 chars)", 400, "VALIDATION_ERROR");
    if (message.length > 5000) return secureErrorResponse("Message too long (max 5000 chars)", 400, "VALIDATION_ERROR");

    const validCategories = ["domain", "hosting", "billing", "technical", "other"];
    const resolvedCategory = validCategories.includes(category) ? category : "other";

    const attachmentResult = validateAttachments(attachments, {
      userId: userIdStr,
      route: "user.create-ticket",
    });
    if (!attachmentResult.ok) {
      return secureErrorResponse(attachmentResult.error, 400, "VALIDATION_ERROR");
    }

    const ticket = await createSupportTicket({
      userId: user._id,
      userEmail: user.email,
      userName: `${user.firstName} ${user.lastName}`.trim(),
      subject: subject.trim(),
      category: resolvedCategory,
      messages: [{
        content: message.trim(),
        authorId: user._id,
        authorRole: "user",
        authorName: `${user.firstName} ${user.lastName}`.trim(),
        attachments: attachmentResult.attachments,
      }],
    });

    // Notify admin — every user-supplied field is HTML-escaped before
    // interpolation to prevent stored XSS or HTML injection in the email.
    const safeSubject = escapeHtml(subject.trim());
    const safeUserName = escapeHtml(ticket.userName);
    const safeUserEmail = escapeHtml(ticket.userEmail);
    const safeMessageHtml = escapeHtml(message.trim()).replace(/\n/g, "<br>");
    EmailService.sendEmail({
      to: process.env.ADMIN_EMAIL ?? "sales@anutech.in",
      subject: `[Support] New Ticket: ${ticket.ticketNumber} — ${subject.trim()}`,
      html: `<p>A new support ticket has been opened.</p>
<p><strong>Ticket:</strong> ${ticket.ticketNumber}<br>
<strong>From:</strong> ${safeUserName} (${safeUserEmail})<br>
<strong>Category:</strong> ${resolvedCategory}<br>
<strong>Subject:</strong> ${safeSubject}</p>
<p><strong>Message:</strong><br>${safeMessageHtml}</p>
${attachmentResult.attachments.length > 0 ? `<p><strong>Attachments:</strong> ${attachmentResult.attachments.length} image(s) — view them in the admin panel.</p>` : ""}
<p><a href="${process.env.NEXTAUTH_URL}/admin/support-tickets/${ticket._id}">View ticket in admin panel</a></p>`,
    }).catch(() => {});

    return secureJsonResponse({ ticket }, 201);
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
