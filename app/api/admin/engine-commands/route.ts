/**
 * The stuck-command desk. Admin-only, inside this app — not part of the
 * ResellerOS contract.
 *
 *   GET                      — commands awaiting reconciliation, oldest first
 *   POST { action: "settle" }  — ask the provider what happened
 *   POST { action: "resolve" | "requeue", who, why } — a human decides
 *
 * ─── WHY THIS IS NOT ON THE ENGINE API ───────────────────────────────────────
 * Freeing a held subject claim is the single most dangerous button in the
 * system: get it wrong and the next command registers a domain that is already
 * registered. ResellerOS has no way to know whether the work happened — it is
 * the side that asked and never got an answer. The evidence lives in the
 * provider's console, which is this side's business, so the decision lives
 * here too, behind an admin session rather than a shared API key.
 *
 * ─── SETTLE FIRST, DECIDE SECOND ─────────────────────────────────────────────
 * `settle` asks the provider and only acts on a definite answer. The human
 * actions exist because most commands have no reconciler yet and some never
 * will — but a machine answer, where one is available, beats a person reading
 * a console under time pressure.
 */
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import {
  listStuckCommands,
  settleCommand,
  decideStuckCommand,
} from "@/lib/services/engine-commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const admin = await AuthService.getAdminFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const stuck = await listStuckCommands();
  return NextResponse.json({
    count: stuck.length,
    commands: stuck.map((c) => ({
      commandId: c.commandId,
      command: c.command,
      subject: c.subject,
      transport: c.transport ?? null,
      error: c.error ?? null,
      createdAt: c.createdAt,
      /** How long this subject has been locked — the cost of not deciding. */
      heldForMs: Date.now() - new Date(c.createdAt).getTime(),
    })),
    note:
      stuck.length === 0
        ? "Nothing is stuck. Every command either completed or failed cleanly."
        : "Each of these is holding its subject locked, so nothing else can act on it. " +
          "Settle asks the provider; resolve/requeue records what you found.",
  });
}

export async function POST(request: NextRequest) {
  const admin = await AuthService.getAdminFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const commandId = typeof b.commandId === "string" ? b.commandId.trim() : "";
  const action = typeof b.action === "string" ? b.action.trim() : "";

  if (!commandId) {
    return NextResponse.json({ error: '"commandId" is required.' }, { status: 400 });
  }

  if (action === "settle") {
    const out = await settleCommand(commandId);
    if (!out.ok) return NextResponse.json({ error: out.detail }, { status: 409 });
    return NextResponse.json(out, { status: 200 });
  }

  if (action === "resolve" || action === "requeue") {
    const who = typeof b.who === "string" ? b.who.trim() : "";
    const why = typeof b.why === "string" ? b.why.trim() : "";
    /**
     * Both required. A row saying a claim was freed, without who freed it or
     * what they saw, is worse than no row — it looks like accountability while
     * recording none, and this is the decision somebody will be asked about
     * when a domain turns out to be registered twice.
     */
    if (!who || !why) {
      return NextResponse.json(
        {
          error:
            'Both "who" and "why" are required. This frees a locked subject on your word — ' +
            "record who checked and what they saw in the provider's console, because that is " +
            "the only evidence this decision will ever have.",
        },
        { status: 400 }
      );
    }

    const out = await decideStuckCommand({
      commandId,
      decision: action as "resolve" | "requeue",
      who,
      why,
    });
    if (!out.ok) return NextResponse.json({ error: out.detail }, { status: 409 });
    serverLogger.warn(
      `[engine] admin ${admin.email ?? admin._id} ${action}d ${commandId}`
    );
    return NextResponse.json(out, { status: 200 });
  }

  return NextResponse.json(
    {
      error:
        '"action" must be "settle" (ask the provider), "resolve" (you confirmed it DID ' +
        'happen) or "requeue" (you confirmed it did NOT).',
    },
    { status: 400 }
  );
}
