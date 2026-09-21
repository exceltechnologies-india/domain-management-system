/**
 * Which commands this engine knows about, and which it can actually perform.
 *
 * The two are deliberately different lists. A command that is KNOWN but has no
 * handler gets a specific, honest refusal — "this engine does not do that yet"
 * — while an unrecognised one is a caller bug. Collapsing them into a single
 * "unknown command" would make a not-yet-built feature indistinguishable from a
 * typo, and the caller would go looking in the wrong place.
 *
 * Nothing here contacts a provider. The real handlers arrive in Phases 6-9, one
 * blast radius at a time: DNS and suspend first (free, reversible), then
 * hosting provision, then domain renew, and domain register last.
 */
import type { EngineMode } from "./engine-mode";

/** Every command the contract names, whether or not it is implemented. */
export const KNOWN_COMMANDS = [
  /** Exercises the whole path without doing anything. See the handler below. */
  "engine.selftest",
  "dns.record.upsert",
  "hosting.suspend",
  "hosting.unsuspend",
  "hosting.provision",
  "hosting.change_plan",
  "domain.renew",
  "domain.register",
] as const;

export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

export function isKnownCommand(value: string): value is KnownCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(value);
}

export interface HandlerContext {
  commandId: string;
  subject: string;
  mode: EngineMode;
  payload: Record<string, unknown>;
}

export interface HandlerResult {
  /** Stored on the command and replayed verbatim on a duplicate commandId. */
  result: Record<string, unknown>;
}

export type CommandHandler = (ctx: HandlerContext) => Promise<HandlerResult>;

/**
 * The only handler that exists today.
 *
 * It exists so the caller path can be exercised for real — auth, validation,
 * the idempotency store, the subject mutex, dispatch, completion and replay —
 * rather than asserted in tests alone. It touches nothing, which is the point:
 * a green run proves the plumbing and nothing else, and cannot be mistaken for
 * proof that a provider call works.
 */
const selftest: CommandHandler = async (ctx) => ({
  result: {
    ok: true,
    echoed: ctx.payload,
    subject: ctx.subject,
    mode: ctx.mode,
    note:
      "engine.selftest performs no work and contacts no provider. It exists to exercise the " +
      "command path end to end.",
  },
});

/**
 * Deliberately sparse. Adding a key here is what makes a command performable,
 * so the map is the one place to look when asking "can this engine actually do
 * X" — and adding one is a visible decision rather than a side effect of
 * writing a function somewhere.
 */
export const HANDLERS: Partial<Record<KnownCommand, CommandHandler>> = {
  "engine.selftest": selftest,
};

export function handlerFor(command: KnownCommand): CommandHandler | null {
  return HANDLERS[command] ?? null;
}
