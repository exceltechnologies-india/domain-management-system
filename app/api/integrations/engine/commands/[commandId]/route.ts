/**
 * GET /api/integrations/engine/commands/:commandId — what happened to it.
 *
 * ─── THE READ KEY, NOT THE COMMAND KEY ───────────────────────────────────────
 * Deliberate, and the reason is blast radius. Whatever polls a command's status
 * would otherwise have to hold `BILLING_COMMAND_API_KEY` — the key that can
 * register domains — purely to ask a question. Polling is the most widely
 * deployed part of any integration; making it require the most dangerous
 * credential is how that credential ends up everywhere.
 *
 * Reading a command changes nothing, so it belongs with the other reads.
 *
 * ─── WHY THIS EXISTS BEFORE THE COMMANDS THAT NEED IT ────────────────────────
 * A caller whose request timed out has exactly one safe move: ask what
 * happened. Without this endpoint its only options are to retry — which is how
 * a domain gets registered twice — or to give up on a command that may have
 * succeeded. Phase 5 builds the way out before Phase 6+ builds the things that
 * get stuck.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeEngineReadRequest } from "@/lib/integrations/engine-auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { findCommand } from "@/lib/services/engine-commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ commandId: string }> }
) {
  if (!authorizeEngineReadRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimiters.engineRead.isAllowed(request);
  if (!rl.allowed) return rateLimitResponse(rl, { message: "Too many requests." });

  const { commandId } = await params;
  const doc = await findCommand(commandId);

  if (!doc) {
    /**
     * 404 with an explicit "never seen", because the alternative reading is
     * dangerous. A caller whose request timed out needs to distinguish "you
     * never received it, send it again" from "it is still running, do not".
     * An ambiguous 404 invites the retry that duplicates the work.
     */
    return NextResponse.json(
      {
        found: false,
        commandId,
        error:
          "No command with that id has ever been received here. If you sent one and never got " +
          "a reply, it did not arrive — sending it again with the same commandId is safe.",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    found: true,
    commandId: doc.commandId,
    command: doc.command,
    subject: doc.subject,
    status: doc.status,
    transport: doc.transport ?? null,
    result: doc.result ?? null,
    error: doc.error ?? null,
    attempts: doc.attempts,
    createdAt: doc.createdAt,
    completedAt: doc.completedAt ?? null,
    /**
     * Said plainly rather than left to the caller to infer from the status
     * string. `needs_reconciliation` is the one state where retrying is the
     * wrong move, and it is also the one a caller is least likely to have
     * handled.
     */
    safeToRetry: doc.status === "failed",
    note:
      doc.status === "needs_reconciliation"
        ? "This may or may not have taken effect at the provider, and the subject is locked " +
          "until somebody establishes which. Do NOT send it again."
        : doc.status === "failed"
          ? "Nothing took effect. Sending a new command for this subject is safe."
          : undefined,
  });
}
