/**
 * GET /api/integrations/engine/services?email=… — every domain and hosting
 * account this engine holds for one person.
 *
 * ─── IDENTITY IS THE EMAIL, AND ONLY THE EMAIL ───────────────────────────────
 * ResellerOS and this app keep separate user tables and always will. The email
 * is the one field both sides independently hold for the same human, so it is
 * the join key — the same choice `lib/integrations/billing-customer.ts` makes in
 * the other direction. Nothing is written here, so a mismatched email costs a
 * blank panel, not a corrupted record.
 *
 * ─── "NO ACCOUNT HERE" IS A 200, NOT A 404 ───────────────────────────────────
 * Most ResellerOS customers have never bought hosting or a domain, so having no
 * account in this app is the COMMON case, not an error. A 404 would make the
 * calling page render an error box for the majority of its customers, and would
 * be indistinguishable from a genuinely broken route. So an unknown email
 * returns 200 with `linked: false` and empty arrays, and the panel renders
 * "no services" — which is the truth.
 *
 * The same reasoning as the best-effort degradation in `billing-customer.ts`:
 * an integration that reports absence as failure trains people to ignore it.
 *
 * ─── WHAT IS DELIBERATELY NOT RETURNED ───────────────────────────────────────
 * Not: `razorpayTokenId`, `razorpayCustomerId`, `paymentId`. Those are payment
 * credentials and references; a panel that lists a customer's services has no
 * use for them, and every field shipped across a boundary is a field that ends
 * up in the other side's logs. Add a field when a screen needs it, not in case.
 *
 * Soft-deleted domains are already excluded by `listDomainsForUser`.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeEngineReadRequest } from "@/lib/integrations/engine-auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { getUserByEmail } from "@/lib/services/users";
import { listDomainsForUser } from "@/lib/services/domains";
import { listHostingsForUser } from "@/lib/services/hostings";
import { serverLogger } from "@/lib/server-logger";
import { secureErrorResponse } from "@/lib/api-response-wrapper";
import { z } from "@/lib/api-validation";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  email: z.string().trim().min(3).max(254).email(),
});

export async function GET(request: NextRequest) {
  if (!authorizeEngineReadRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimiters.engineRead.isAllowed(request);
  if (!rl.allowed) {
    return rateLimitResponse(rl, { message: "Too many requests." });
  }

  const parsed = querySchema.safeParse({
    email: request.nextUrl.searchParams.get("email") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "A valid `email` query parameter is required.", code: "VALIDATION_ERROR" },
      { status: 400 }
    );
  }
  // Stored lowercase by the User schema; normalise so a differently-cased
  // address from ResellerOS still matches rather than silently returning empty.
  const email = parsed.data.email.toLowerCase();

  try {
    const user = await getUserByEmail(email);
    if (!user) {
      return NextResponse.json({ linked: false, domains: [], hostings: [] });
    }

    const userId = user._id.toString();
    const [domains, hostings] = await Promise.all([
      listDomainsForUser(userId),
      listHostingsForUser(userId),
    ]);

    return NextResponse.json({
      linked: true,
      customer: {
        id: userId,
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(" ").trim(),
        companyName: user.companyName ?? null,
      },
      domains: domains.map((d) => ({
        id: d._id.toString(),
        domainName: d.domainName,
        status: d.status,
        registeredAt: d.registeredAt ?? null,
        expiresAt: d.expiresAt ?? null,
        autoRenew: d.autoRenew ?? false,
        privacyProtection: d.privacyProtection ?? false,
        nameservers: d.nameservers ?? [],
      })),
      hostings: hostings.map((h) => ({
        id: h._id.toString(),
        domainName: h.domainName,
        planName: h.name,
        status: h.status,
        startDate: h.startDate ?? null,
        expiryDate: h.expiryDate ?? null,
        autoRenew: h.autoRenew ?? false,
        isTrial: h.isTrial ?? false,
        // Staff-facing: this is what an admin needs to find the account on the
        // DirectAdmin server. It is a username, not a credential.
        directAdminUsername: h.directAdminUsername ?? null,
      })),
    });
  } catch (err) {
    serverLogger.error(`[engine-api] services lookup failed for ${email}`, err);
    return secureErrorResponse(
      "Could not read services.",
      500,
      "ENGINE_SERVICES_FAILED",
      err
    );
  }
}
