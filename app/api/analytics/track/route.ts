import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { AUTH_SECRET } from "@/lib/auth-secret";
import { recordActivity } from "@/lib/services/analytics";
import { validatedBody, z } from "@/lib/api-validation";

// Client-fireable journey events only. Server-side milestones (registration,
// purchase, domain_added, …) are recorded directly from their own flows and
// must NOT be settable from the public browser endpoint.
const CLIENT_ALLOWED = ["landing_page_visit", "view_content", "start_trial", "checkout_started"] as const;

const schema = z.object({
  activity: z.enum(CLIENT_ALLOWED),
  anonId: z.string().max(64).optional(),
});

export async function POST(request: NextRequest) {
  const validation = await validatedBody(request, schema);
  if (!validation.ok) return validation.response;

  // Best-effort: attach the user id if a session cookie is present.
  let userId: string | null = null;
  try {
    const token = await getToken({ req: request, secret: AUTH_SECRET });
    const id = (token?.id as string | undefined) ?? token?.sub ?? null;
    userId = id ? String(id) : null;
  } catch {
    userId = null;
  }

  await recordActivity({
    activity: validation.data.activity,
    userId,
    anonId: validation.data.anonId ?? null,
  });

  return NextResponse.json({ ok: true });
}
