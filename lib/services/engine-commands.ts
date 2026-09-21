/**
 * The idempotency store and the subject mutex, as a pair.
 *
 * Nothing routes here yet — Phase 2 builds the guarantees before anything can
 * spend money through them. The shape a future command route takes is:
 *
 *   const seen = await findCommand(commandId);      // replay?
 *   const claim = await acquireSubjectClaim(...);   // anyone else on this?
 *   ... do the work ...
 *   await completeCommand(...);                     // releases the claim
 *
 * The two questions are genuinely different and the code keeps them apart:
 * `commandId` answers "have I been asked this exact thing before", and
 * `{command, subject}` answers "is something already happening to this thing".
 * A retry is the first; two operators both registering example.com is the
 * second.
 */
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import { serverLogger } from "@/lib/server-logger";
import EngineCommand, {
  type IEngineCommand,
  type EngineCommandStatus,
} from "@/models/EngineCommand";
import EngineSubjectClaim from "@/models/EngineSubjectClaim";
import type { Transport } from "@/lib/integrations/transport";
import { reconcileCommand, statusForVerdict } from "@/lib/integrations/engine-reconcile";

/** Mongo's duplicate-key error. The unique index IS the concurrency control. */
const DUPLICATE_KEY = 11000;

function isDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: number }).code === DUPLICATE_KEY);
}

/**
 * How long a claim is honoured before the TTL may reap it.
 *
 * Long enough that a slow registrar call does not lose its lock mid-flight —
 * ResellerClub registrations are not fast — and short enough that a crashed
 * holder does not block a domain for an afternoon. The failure modes are
 * asymmetric: too short risks two concurrent registrations, too long risks a
 * support ticket, so this errs long.
 */
export const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;

export type AcquireResult =
  | { ok: true }
  /** Someone else holds it. `heldBy` is their commandId, for the message. */
  | { ok: false; reason: "held"; heldBy: string; expiresAt: Date };

/**
 * Take the claim, or report who has it.
 *
 * insert-or-fail, never read-then-write: two callers that both read "free"
 * would both then write, and the whole point is that exactly one proceeds.
 * The duplicate-key error from the unique index is the signal, not an
 * exception to handle away.
 */
export async function acquireSubjectClaim(
  command: string,
  subject: string,
  commandId: string,
  ttlMs: number = DEFAULT_CLAIM_TTL_MS
): Promise<AcquireResult> {
  await connectDB();
  const expiresAt = new Date(Date.now() + ttlMs);

  try {
    await EngineSubjectClaim.create({ command, subject, commandId, expiresAt });
    return { ok: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;

    const holder = await EngineSubjectClaim.findOne({ command, subject }).lean();
    if (!holder) {
      /**
       * It was released between the failed insert and this read. Rare, and
       * reported as held rather than retried: a caller that loops here turns
       * a mutex into a spin, and the honest answer is "try again", which the
       * caller can decide about.
       */
      return {
        ok: false,
        reason: "held",
        heldBy: "(released while checking)",
        expiresAt: new Date(),
      };
    }

    /**
     * An EXPIRED row still holds the unique key until Mongo's TTL monitor
     * sweeps it, which runs about once a minute. Reporting it as held is
     * correct but unhelpful, so say when it lapsed — the caller can then tell
     * "someone is working on this" from "something died holding this".
     */
    if (holder.expiresAt.getTime() <= Date.now()) {
      serverLogger.warn(
        `[engine] claim on ${command}/${subject} lapsed at ${holder.expiresAt.toISOString()} ` +
          `but is not swept yet (held by ${holder.commandId})`
      );
    }

    return {
      ok: false,
      reason: "held",
      heldBy: holder.commandId,
      expiresAt: holder.expiresAt,
    };
  }
}

/**
 * Release the claim — but only if this command still owns it.
 *
 * The `commandId` filter is what stops a slow holder releasing a lock that
 * the TTL already reaped and someone else has since taken. Without it, a
 * command that stalled past its TTL would come back and free somebody else's
 * claim, and two registrations would run.
 */
export async function releaseSubjectClaim(
  command: string,
  subject: string,
  commandId: string
): Promise<boolean> {
  await connectDB();
  const res = await EngineSubjectClaim.deleteOne({ command, subject, commandId });
  return res.deletedCount > 0;
}

/** The stored command for this idempotency key, if it has been seen. */
export async function findCommand(commandId: string): Promise<IEngineCommand | null> {
  await connectDB();
  return EngineCommand.findOne({ commandId });
}

export type StartResult =
  | { ok: true; command: IEngineCommand }
  /** Seen before. `command` carries whatever is known, including a result. */
  | { ok: false; reason: "duplicate"; command: IEngineCommand };

/**
 * Record a command as received, or report it as a duplicate.
 *
 * The insert is the check. A `findOne` then `create` would let two copies of
 * the same retry both see "new" and both proceed — which is the bug this
 * store exists to prevent, reintroduced inside its own implementation.
 */
export async function startCommand(input: {
  commandId: string;
  command: string;
  subject: string;
  request?: Record<string, unknown>;
}): Promise<StartResult> {
  await connectDB();
  try {
    const doc = await EngineCommand.create({
      commandId: input.commandId,
      command: input.command,
      subject: input.subject,
      request: input.request,
      status: "received",
      attempts: 1,
    });
    return { ok: true, command: doc };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const existing = await EngineCommand.findOne({ commandId: input.commandId });
    if (!existing) throw err; // vanished between insert and read — nothing sane to say
    return { ok: false, reason: "duplicate", command: existing };
  }
}

/**
 * Move a command to a terminal state and release its claim.
 *
 * `needs_reconciliation` is the exception, and it is the reason this function
 * owns the release rather than the caller: when the provider call came back
 * `sent_unknown`, the work may have happened. Releasing the claim would let
 * the next attempt register the same domain a second time — so the claim is
 * deliberately KEPT, and the subject stays locked until a human or a
 * reconciliation pass has looked at the provider.
 *
 * That is the whole reason Phase 1's transport had to exist before this.
 */
export async function completeCommand(input: {
  commandId: string;
  status: Extract<EngineCommandStatus, "succeeded" | "failed" | "needs_reconciliation">;
  result?: Record<string, unknown>;
  error?: string;
  transport?: Transport;
}): Promise<IEngineCommand | null> {
  await connectDB();

  const doc = await EngineCommand.findOneAndUpdate(
    { commandId: input.commandId },
    {
      $set: {
        status: input.status,
        result: input.result,
        error: input.error,
        transport: input.transport,
        completedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!doc) return null;

  if (input.status === "needs_reconciliation") {
    serverLogger.error(
      `[engine] ${doc.command} on ${doc.subject} (${doc.commandId}) may have completed at the ` +
        `provider — the claim is being HELD so nothing retries it. Reconcile against the ` +
        `provider before releasing.`
    );
    return doc;
  }

  await releaseSubjectClaim(doc.command, doc.subject, doc.commandId);
  return doc;
}

/** Mark the work as started. Separate from startCommand so a queued command reads honestly. */
export async function markInProgress(commandId: string): Promise<void> {
  await connectDB();
  await EngineCommand.updateOne(
    { commandId },
    { $set: { status: "in_progress", startedAt: new Date() }, $inc: { attempts: 1 } }
  );
}

/**
 * Release a claim a human has reconciled.
 *
 * Deliberately not part of completeCommand: the whole point of holding a
 * `needs_reconciliation` claim is that only someone who has LOOKED at the
 * provider may free it.
 */
export async function releaseAfterReconciliation(commandId: string): Promise<boolean> {
  await connectDB();
  const doc = await EngineCommand.findOne({ commandId });
  if (!doc) return false;
  return releaseSubjectClaim(doc.command, doc.subject, doc.commandId);
}

/** Exposed for tests and tooling; not part of the command flow. */
export function isDuplicateKeyError(err: unknown): boolean {
  return isDuplicateKey(err);
}

export { mongoose };

// ─── Recovery ────────────────────────────────────────────────────────────────
// Built before the commands that need it (Phase 5 before Phase 6+), because a
// stuck command with no way out is worse than a command that was never sent.

/** Commands waiting on a human, oldest first — the ones holding a subject. */
export async function listStuckCommands(limit = 100): Promise<IEngineCommand[]> {
  await connectDB();
  return EngineCommand.find({ status: "needs_reconciliation" })
    .sort({ createdAt: 1 })
    .limit(limit);
}

export type SettleOutcome =
  | { ok: true; settled: true; status: "succeeded" | "failed"; detail: string }
  /** Nothing was learned. The claim stays held and a human is still needed. */
  | { ok: true; settled: false; detail: string }
  | { ok: false; reason: "not_found" | "not_stuck"; detail: string };

/**
 * Ask the provider what happened, and settle the command if it answers.
 *
 * Only runs against `needs_reconciliation`. Refusing to touch anything else is
 * not pedantry: a settled command has already released its claim, so
 * "reconciling" it again would ask the provider about work that finished
 * normally, and an ambiguous answer could then reopen it.
 */
export async function settleCommand(commandId: string): Promise<SettleOutcome> {
  await connectDB();
  const doc = await EngineCommand.findOne({ commandId });
  if (!doc) {
    return { ok: false, reason: "not_found", detail: `No command ${commandId}.` };
  }
  if (doc.status !== "needs_reconciliation") {
    return {
      ok: false,
      reason: "not_stuck",
      detail:
        `Command ${commandId} is "${doc.status}", not awaiting reconciliation. ` +
        `Only a command whose outcome is genuinely unknown can be settled.`,
    };
  }

  const { verdict, detail } = await reconcileCommand(doc.command, {
    subject: doc.subject,
    request: (doc.request ?? {}) as Record<string, unknown>,
  });

  const status = statusForVerdict(verdict);
  if (!status) {
    serverLogger.warn(
      `[engine] ${commandId} still unsettled after reconciliation: ${detail}`
    );
    return { ok: true, settled: false, detail };
  }

  await EngineCommand.updateOne(
    { commandId },
    {
      $set: {
        status,
        error: status === "failed" ? detail : undefined,
        completedAt: new Date(),
        note: `settled by reconciliation: ${detail}`,
      },
    }
  );
  await releaseSubjectClaim(doc.command, doc.subject, doc.commandId);
  serverLogger.info(`[engine] ${commandId} settled as ${status}: ${detail}`);
  return { ok: true, settled: true, status, detail };
}

export type OperatorDecision = "resolve" | "requeue";

/**
 * A human settles what the machine could not.
 *
 * `resolve`  — "I looked; the work DID happen." Marks succeeded.
 * `requeue`  — "I looked; it did NOT happen." Marks failed and frees the
 *              subject so a NEW command may be sent.
 *
 * Requeue deliberately does NOT retry. It releases the lock and stops. An
 * automatic retry here would re-run something whose outcome a human has just
 * had to establish by hand — and if they were wrong, the retry is the second
 * registration. Sending the new command is a separate, deliberate act with its
 * own commandId.
 *
 * `who` and `why` are required. An audit row that says a claim was freed but
 * not by whom or on what evidence is the kind of record that is worse than
 * none: it looks like accountability.
 */
export async function decideStuckCommand(input: {
  commandId: string;
  decision: OperatorDecision;
  who: string;
  why: string;
}): Promise<SettleOutcome> {
  await connectDB();
  const doc = await EngineCommand.findOne({ commandId: input.commandId });
  if (!doc) {
    return { ok: false, reason: "not_found", detail: `No command ${input.commandId}.` };
  }
  if (doc.status !== "needs_reconciliation") {
    return {
      ok: false,
      reason: "not_stuck",
      detail: `Command ${input.commandId} is "${doc.status}" — there is nothing to decide.`,
    };
  }

  const status = input.decision === "resolve" ? "succeeded" : "failed";
  const note =
    `${input.decision} by ${input.who}: ${input.why}` +
    (input.decision === "requeue"
      ? " — the subject is free again; send a NEW commandId to retry."
      : "");

  await EngineCommand.updateOne(
    { commandId: input.commandId },
    { $set: { status, completedAt: new Date(), note, error: status === "failed" ? note : undefined } }
  );
  await releaseSubjectClaim(doc.command, doc.subject, doc.commandId);
  serverLogger.warn(`[engine] ${input.commandId} ${input.decision}d by ${input.who}: ${input.why}`);
  return { ok: true, settled: true, status, detail: note };
}
