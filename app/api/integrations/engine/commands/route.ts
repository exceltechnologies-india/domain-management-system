/**
 * POST /api/integrations/engine/commands — ask this engine to do something.
 *
 * Phase 4: the whole caller path, wired end to end, with `mode: "live"` HARD
 * DISABLED in code. Auth, validation, the idempotency store, the subject mutex,
 * dispatch, completion and replay all run for real — and nothing here can spend
 * a rupee, because the only registered handler contacts nothing and live is
 * refused before any of it.
 *
 * The order of the gates is the design:
 *
 *   1. auth          — the command key, not the read key. Different blast radius.
 *   2. shape         — mode is REQUIRED with no default (see engine-mode.ts).
 *   3. live refused  — 503, before anything is written. A refused command
 *                      leaves no row, so retrying after live is enabled is
 *                      clean rather than a duplicate.
 *   4. known command — a known-but-unimplemented command is 501, an unknown one
 *                      is 400. Same reasoning as the registry: "not built yet"
 *                      and "you typo'd" send you to different places.
 *   5. idempotency   — a repeated commandId REPLAYS, it does not re-run.
 *   6. subject mutex — one operation per {command, subject} at a time.
 *
 * 5 before 6 on purpose: a retry of a command that is still running should be
 * told "already in progress" by its own record, not by failing to take a lock
 * it already holds.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeEngineCommandRequest } from "@/lib/integrations/engine-auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { checkMode } from "@/lib/integrations/engine-mode";
import { isKnownCommand, handlerFor } from "@/lib/integrations/engine-command-registry";
import { transportOf } from "@/lib/integrations/engine-attempt";
import {
  startCommand,
  acquireSubjectClaim,
  markInProgress,
  completeCommand,
} from "@/lib/services/engine-commands";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!authorizeEngineCommandRequest(request)) {
    // Deliberately terse, like the other engine routes: a caller with the wrong
    // key learns nothing about what a right one would unlock.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await rateLimiters.engineCommand.isAllowed(request);
  if (!rl.allowed) {
    return rateLimitResponse(rl, { message: "Too many commands." });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const commandId = typeof b.commandId === "string" ? b.commandId.trim() : "";
  const command = typeof b.command === "string" ? b.command.trim() : "";
  const subject = typeof b.subject === "string" ? b.subject.trim() : "";
  const payload = (b.payload ?? {}) as Record<string, unknown>;

  if (!commandId || !command || !subject) {
    return NextResponse.json(
      {
        error:
          'A command needs "commandId", "command" and "subject". commandId is your ' +
          "idempotency key — reuse it to retry safely, change it to ask for something new.",
      },
      { status: 400 }
    );
  }

  const mode = checkMode(b.mode);
  if (!mode.ok) {
    // Before any write. A refused command must leave no trace, so that
    // retrying it once live is enabled is a fresh request and not a replay of
    // a row that records a refusal.
    return NextResponse.json({ error: mode.error }, { status: mode.status });
  }

  if (!isKnownCommand(command)) {
    return NextResponse.json(
      { error: `Unknown command "${command}". Check the name against the engine contract.` },
      { status: 400 }
    );
  }

  const handler = handlerFor(command);
  if (!handler) {
    return NextResponse.json(
      {
        error:
          `"${command}" is part of the contract but this engine cannot perform it yet. ` +
          "Nothing was recorded and nothing was claimed. Do it by hand in the provider's " +
          "console for now.",
      },
      { status: 501 }
    );
  }

  // ─── Idempotency: a repeat REPLAYS ─────────────────────────────────────────
  const started = await startCommand({ commandId, command, subject, request: payload });
  if (!started.ok) {
    const prior = started.command;
    return NextResponse.json(
      {
        replayed: true,
        commandId,
        status: prior.status,
        result: prior.result ?? null,
        error: prior.error ?? null,
        note:
          "This commandId has been seen before, so the stored outcome is returned and nothing " +
          "ran again. Send a different commandId to ask for new work.",
      },
      { status: 200 }
    );
  }

  // ─── Mutex: one operation per subject ──────────────────────────────────────
  const claim = await acquireSubjectClaim(command, subject, commandId);
  if (!claim.ok) {
    /**
     * The command row stays, recording that this was asked and refused. It is
     * marked failed rather than left at `received`, or a later reader would
     * think it is still queued — and completeCommand's release is a no-op here
     * because this command never held the claim (the release is filtered by
     * commandId).
     */
    await completeCommand({
      commandId,
      status: "failed",
      error: `another command (${claim.heldBy}) is already working on ${subject}`,
    });
    return NextResponse.json(
      {
        error:
          `Something is already running "${command}" on ${subject} (command ${claim.heldBy}). ` +
          "Wait for it to finish rather than starting a second one — two at once is how the " +
          "same thing gets bought twice.",
      },
      { status: 409 }
    );
  }

  // ─── Do the work ───────────────────────────────────────────────────────────
  await markInProgress(commandId);
  try {
    const { result } = await handler({ commandId, subject, mode: mode.mode, payload });
    await completeCommand({ commandId, status: "succeeded", result, transport: "responded" });
    return NextResponse.json({ replayed: false, commandId, status: "succeeded", result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(`[engine] ${command} on ${subject} (${commandId}) threw: ${message}`);
    /**
     * How far did it get? The handler is the only thing that knows, so it says
     * so by branding the error — `lib/integrations/engine-attempt.ts`.
     *
     * An UNBRANDED throw is `not_sent`, and that is an answer rather than a
     * fallback: everything before the first wrapped write — validation, a
     * missing record, a failed READ — cannot have changed anything.
     *
     * This branch used to assume `not_sent` unconditionally, on the stated
     * grounds that no handler contacted a provider yet. Phase 6 made that
     * false and nothing forced the comment to change, so a DNS write that died
     * in flight was recorded as never sent and its subject was released.
     */
    const transport = transportOf(err) ?? "not_sent";
    /**
     * `sent_unknown` is the one case that must not close. The work may have
     * happened, so the claim is HELD and a human reconciles before anything
     * touches this subject again.
     */
    const status = transport === "sent_unknown" ? "needs_reconciliation" : "failed";

    await completeCommand({ commandId, status, error: message, transport });

    if (status === "needs_reconciliation") {
      return NextResponse.json(
        {
          error:
            "The request reached the provider and we did not learn what it did. It has NOT " +
            "been retried and this subject is locked. Check the provider, then settle this " +
            "command — do not send it again with a new commandId.",
          commandId,
          status,
          transport,
        },
        { status: 500 }
      );
    }
    return NextResponse.json(
      {
        error:
          transport === "responded"
            ? `The provider refused the request: ${message}`
            : "The command failed before reaching any provider. Nothing was changed.",
        commandId,
        status,
        transport,
      },
      { status: 500 }
    );
  }
}
