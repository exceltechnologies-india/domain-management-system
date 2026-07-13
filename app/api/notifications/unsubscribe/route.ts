import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe-token";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

function page(title: string, body: string, status = 200): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="font-family: Arial, sans-serif; background:#f8f9fa; margin:0; padding:40px 16px;">
  <div style="max-width:480px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:32px; text-align:center;">
    <h1 style="font-size:20px; color:#111827; margin:0 0 12px;">${title}</h1>
    ${body}
    <p style="font-size:12px; color:#9ca3af; margin-top:24px;">Anutech Digital · <a href="mailto:${SUPPORT_EMAIL}" style="color:#6b7280;">${SUPPORT_EMAIL}</a></p>
  </div>
</body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * GET — scanner-safe: performs NO state change. Renders a confirmation page
 * with a POST form so an email-scanner that merely follows the link can't
 * unsubscribe the user by accident. The actual opt-out happens on POST.
 */
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const email = verifyUnsubscribeToken(token);
  if (!email) {
    return page(
      "Invalid unsubscribe link",
      `<p style="color:#6b7280; font-size:14px;">This link is invalid or has expired. Please use the unsubscribe link from a recent email, or contact support.</p>`,
      400
    );
  }
  const q = `?token=${encodeURIComponent(token)}`;
  return page(
    "Manage email notifications",
    `<p style="color:#374151; font-size:14px; margin-bottom:20px;">Unsubscribe <strong>${email}</strong> from optional notification emails (marketing + service reminders)? You'll still receive important account, billing, and security emails.</p>
     <form method="POST" action="/api/notifications/unsubscribe${q}" style="margin-bottom:12px;">
       <button type="submit" name="action" value="unsubscribe" style="background:#dc2626; color:#fff; border:none; padding:12px 24px; border-radius:8px; font-size:14px; font-weight:bold; cursor:pointer;">Unsubscribe</button>
     </form>
     <form method="POST" action="/api/notifications/unsubscribe${q}">
       <input type="hidden" name="action" value="resubscribe">
       <button type="submit" style="background:none; color:#6b7280; border:none; text-decoration:underline; font-size:13px; cursor:pointer;">Actually, keep me subscribed</button>
     </form>`
  );
}

/**
 * POST — performs the change. Handles BOTH our confirmation-page form and the
 * RFC 8058 one-click flow (mail client POSTs `List-Unsubscribe=One-Click`).
 * One-click always means unsubscribe. The page form may also resubscribe.
 */
export async function POST(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const email = verifyUnsubscribeToken(token);
  if (!email) {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 400 });
  }

  // Determine intent. Default = unsubscribe (covers one-click, which sends
  // `List-Unsubscribe=One-Click` and no `action`).
  let resubscribe = false;
  try {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
      const form = await request.formData();
      resubscribe = form.get("action") === "resubscribe";
    }
  } catch {
    // No/invalid body → treat as one-click unsubscribe.
  }

  try {
    await connectDB();
    const res = await User.updateOne(
      { email: email.toLowerCase() },
      { $set: { emailOptOut: !resubscribe } }
    );
    if (res.matchedCount === 0) {
      // No account for this email — nothing to change, but don't leak that.
      serverLogger.info(`[Unsubscribe] no user for ${email} (no-op)`);
    } else {
      serverLogger.info(
        `[Unsubscribe] ${email} emailOptOut=${!resubscribe}`
      );
    }
  } catch (err) {
    serverLogger.error(`[Unsubscribe] failed for ${email}:`, err);
    return NextResponse.json({ error: "Could not update preference" }, { status: 500 });
  }

  return page(
    resubscribe ? "You're subscribed" : "You've been unsubscribed",
    resubscribe
      ? `<p style="color:#374151; font-size:14px;">You'll continue to receive optional notification emails.</p>`
      : `<p style="color:#374151; font-size:14px;">You won't receive optional notification emails anymore. Important account, billing, and security emails will still be sent. Changed your mind? Use the link in any future email to resubscribe.</p>`
  );
}
