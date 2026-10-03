import { NextRequest, NextResponse } from "next/server";
import { EmailService } from "@/lib/email";
import { InputValidator } from "@/lib/validation";
import { RecaptchaServer } from "@/lib/recaptcha";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import { COMPANY_PHONE_DISPLAY } from "@/config/company";
import { SUPPORT_EMAIL } from "@/lib/email/transporter";
import { brandName, firstName, plainEmailHtml } from "@/lib/email/plain";

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
    // In the ResellerOS plain-text pattern (lib/email/plain.ts; owner, 3 Oct 2026). Their
    // name, subject and message only reach HTML through plainEmailHtml, which escapes them.
    const quoted = safeMessage.trim().split(/\r?\n/).map((l) => `  ${l}`).join("\n");
    const confirmationText =
`Hi ${firstName(safeName)},

Thank you for contacting us. We have received your message about "${safeSubject}" and will get back to you within 24 hours.

Your message:

${quoted}

Anything urgent? Call us on ${COMPANY_PHONE_DISPLAY}.

Questions? Reply to this email or write to ${SUPPORT_EMAIL}.

— ${brandName()}`;
    await EmailService.sendEmail({
      to: safeEmail,
      subject: `Thank you for contacting ${brandName()}`,
      text: confirmationText,
      html: plainEmailHtml(confirmationText),
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
