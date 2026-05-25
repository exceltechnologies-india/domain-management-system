import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import {
  getTicketById,
  getTicketByIdLean,
  updateTicketByIdAsAdmin,
} from "@/lib/services/support-tickets";
import { EmailService } from "@/lib/email";
import {
  validateAttachments,
  sumExistingAttachmentBytes,
  checkTicketTotalCap,
} from "@/lib/support-attachments";
import { validatedBody, z } from "@/lib/api-validation";

const ATTACHMENT_SHAPE = z.object({
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().nonnegative(),
  dataUrl: z.string(),
});

const patchTicketAdminSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

const replyTicketAdminSchema = z.object({
  message: z.string().trim().min(1, "Message is required").max(5000, "Message too long"),
  attachments: z.array(ATTACHMENT_SHAPE).optional(),
});

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
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { id } = await params;

    const ticket = await getTicketByIdLean(id);
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
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { id } = await params;
    const validation = await validatedBody(request, patchTicketAdminSchema);
    if (!validation.ok) return validation.response;
    const { status, priority } = validation.data;

    const update: Record<string, unknown> = {};
    if (status) {
      update.status = status;
      if (status === "resolved" || status === "closed") {
        update.resolvedAt = new Date();
      } else {
        update.resolvedAt = null;
      }
    }
    if (priority) {
      update.priority = priority;
    }

    const ticket = await updateTicketByIdAsAdmin(id, { $set: update });

    if (!ticket) return secureErrorResponse("Ticket not found", 404, "NOT_FOUND");

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
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { id } = await params;
    const validation = await validatedBody(request, replyTicketAdminSchema);
    if (!validation.ok) return validation.response;
    const { message, attachments } = validation.data;

    const attachmentResult = validateAttachments(attachments, {
      userId: admin._id?.toString(),
      route: "admin.reply",
    });
    if (!attachmentResult.ok) {
      return secureErrorResponse(attachmentResult.error, 400, "VALIDATION_ERROR");
    }

    const ticket = await getTicketById(id);
    if (!ticket) return secureErrorResponse("Ticket not found", 404, "NOT_FOUND");
    if (ticket.status === "closed") return secureErrorResponse("Ticket is closed", 400, "TICKET_CLOSED");

    if (attachmentResult.attachments.length > 0) {
      const existingBytes = sumExistingAttachmentBytes(ticket.messages);
      const capErr = checkTicketTotalCap(existingBytes, attachmentResult.attachments);
      if (capErr) return secureErrorResponse(capErr, 400, "TICKET_STORAGE_FULL");
    }

    const adminName =
      `${admin.firstName} ${admin.lastName}`.trim() || "Support Team";

    ticket.messages.push({
      content: message.trim(),
      authorId: admin._id,
      authorRole: "admin",
      authorName: adminName,
      attachments: attachmentResult.attachments,
      createdAt: new Date(),
    });

    if (ticket.status === "open" || ticket.status === "resolved") {
      if (ticket.status === "resolved") ticket.resolvedAt = undefined;
      ticket.status = "in_progress";
    }
    await ticket.save();

    // Notify user by email — escape user-controlled fields (their name + the
    // ticket subject they originally chose); the admin's message is rendered
    // as escaped HTML too.
    const safeUserName = escapeHtml(ticket.userName);
    const safeMessageHtml = escapeHtml(message.trim()).replace(/\n/g, "<br>");
    EmailService.sendEmail({
      to: ticket.userEmail,
      subject: `Re: [${ticket.ticketNumber}] ${ticket.subject}`,
      html: `<p>Hi ${safeUserName},</p>
<p>Our support team has replied to your ticket <strong>${ticket.ticketNumber}</strong>.</p>
<blockquote style="border-left:4px solid #e5e7eb;padding-left:12px;color:#374151;">${safeMessageHtml}</blockquote>
<p><a href="${process.env.NEXTAUTH_URL}/dashboard/support/${id}">View your ticket</a></p>
<p>— Anutech Digital Support</p>`,
    }).catch(() => {});

    return secureJsonResponse({ ticket });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
