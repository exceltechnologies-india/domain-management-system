import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongoose";
import { MANAGED_PAGES } from "@/config/managed-pages";
import { getPageStatusMap, setPageStatus } from "@/lib/services/page-visibility";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";

/** Shape returned to the admin manager: registry rows + their live status. */
async function buildRows() {
  const statuses = await getPageStatusMap();
  return MANAGED_PAGES.map((p) => ({
    slug: p.slug,
    title: p.title,
    path: p.path,
    description: p.description,
    lockedPublished: Boolean(p.lockedPublished),
    status: statuses[p.slug],
  }));
}

export async function GET(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await connectToDatabase();
    return NextResponse.json({ success: true, pages: await buildRows() });
  } catch (error) {
    serverLogger.error("Page visibility fetch error:", error);
    return NextResponse.json({ error: "Failed to load pages" }, { status: 500 });
  }
}

const patchSchema = z.object({
  slug: z.string().min(1).max(64),
  status: z.enum(["published", "draft"]),
});

export async function PATCH(request: NextRequest) {
  const user = await AuthService.getAdminFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const validation = await validatedBody(request, patchSchema);
  if (!validation.ok) return validation.response;
  const { slug, status } = validation.data;

  try {
    await connectToDatabase();
    await setPageStatus(slug, status, String(user._id ?? user.id ?? "admin"));
    return NextResponse.json({ success: true, pages: await buildRows() });
  } catch (error) {
    // setPageStatus throws a user-facing message for unknown slug / locked page.
    const message = error instanceof Error ? error.message : "Failed to update page";
    const isClientError = /unknown managed page|cannot be set to draft/i.test(message);
    if (!isClientError) serverLogger.error("Page visibility update error:", error);
    return NextResponse.json({ error: message }, { status: isClientError ? 400 : 500 });
  }
}
