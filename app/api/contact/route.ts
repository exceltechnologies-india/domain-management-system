import { NextRequest, NextResponse } from "next/server";
import { EmailService } from "@/lib/email";
import { InputValidator } from "@/lib/validation";
import { RecaptchaServer } from "@/lib/recaptcha";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

// Zod gates the structural shape (every field present + string + bounded);
// the existing InputValidator below still runs content-safety + sanitization
// before the body is rendered into email HTML. reCAPTCHA re-introduced
// 2026-06-20 (env-var presence is the kill switch).
const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(1).max(254),
  subject: z.string().trim().min(1).max(500),
  message: z.string().trim().min(1).max(10000),
  recaptchaToken: z.string().nullable().optional(),
});

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const validation = await validatedBody(request, contactSchema);
    if (!validation.ok) return validation.response;
    const { name, email, subject, message, recaptchaToken } = validation.data;

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Human Verification (reCAPTCHA)
     * Re-introduced 2026-06-20. Skipped when secret is missing (env-var kill switch).
     */
    const clientIP = request.headers.get("x-forwarded-for")?.split(",")[0] ||
                     request.headers.get("x-real-ip") ||
                     "unknown";
    if (recaptchaToken) {
      const recaptchaResult = await RecaptchaServer.verifyToken(recaptchaToken, clientIP);
      if (!recaptchaResult.success) {
        return NextResponse.json(
          { error: "Security verification failed. Please try again." },
          { status: 403 }
        );
      }
    }

    // Validate all inputs
    const nameValidation = InputValidator.validateName(name, "Name");
    const emailValidation = InputValidator.validateEmail(email);
    const subjectValidation = InputValidator.validateMessage(
      subject,
      "Subject"
    );
    const messageValidation = InputValidator.validateMessage(
      message,
      "Message"
    );

    const allErrors = [
      ...nameValidation.errors,
      ...emailValidation.errors,
      ...subjectValidation.errors,
      ...messageValidation.errors,
    ];

    if (allErrors.length > 0) {
      return NextResponse.json(
        { error: allErrors.join(", ") },
        { status: 400 }
      );
    }

    // Send email to admin with sanitized data
    const adminEmail = process.env.ADMIN_EMAIL || "sales@anutech.in";
    const emailSent = await EmailService.sendAdminNotification(
      adminEmail,
      `New Contact Form Submission: ${subjectValidation.sanitized}`,
      `You have received a new contact form submission from ${nameValidation.sanitized} (${emailValidation.sanitized}).`,
      {
        name: nameValidation.sanitized,
        email: emailValidation.sanitized,
        subject: subjectValidation.sanitized,
        message: messageValidation.sanitized,
        timestamp: new Date().toISOString(),
      }
    );

    if (!emailSent) {
      return NextResponse.json(
        { error: "Failed to send message" },
        { status: 500 }
      );
    }

    // Send confirmation email to user with sanitized data.
    // Sanitizers return `string | Record<string,string>` per their generic
    // signature; for single-field inputs they always return string.
    const safeName = String(nameValidation.sanitized || name);
    const safeEmail = String(emailValidation.sanitized || email);
    const safeSubject = String(subjectValidation.sanitized || subject);
    const safeMessage = String(messageValidation.sanitized || message);
    const confirmationEmailSent = await EmailService.sendEmail({
      to: safeEmail,
      subject: "Thank you for contacting Anutech Digital Private Limited",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #3b82f6;">Thank you for contacting us!</h2>
          <p>Hello ${InputValidator.sanitizeHtml(safeName)},</p>
          <p>We have received your message regarding "${InputValidator.sanitizeHtml(safeSubject)}" and will get back to you within 24 hours.</p>
          <p>Your message:</p>
          <div style="background-color: #f3f4f6; padding: 15px; border-radius: 6px; margin: 20px 0;">
            ${InputValidator.sanitizeHtml(safeMessage)}
          </div>
          <p>If you have any urgent questions, please call us at +91-777-888-9674 or email us at <a href="mailto:${process.env.SUPPORT_EMAIL || 'support@anutech.in'}" style="color: #3b82f6;">${process.env.SUPPORT_EMAIL || 'support@anutech.in'}</a>.</p>
          <br>
          <p>Best regards,<br>Anutech Digital Private Limited Team</p>
        </div>
      `,
    });

    return NextResponse.json({
      success: true,
      message: "Message sent successfully",
    });
  } catch (error) {
    serverLogger.error("Contact form error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
