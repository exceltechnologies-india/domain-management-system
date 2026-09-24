/**
 * Which commands this engine knows about, and which it can actually perform.
 *
 * The two are deliberately different lists. A command that is KNOWN but has no
 * handler gets a specific, honest refusal — "this engine does not do that yet"
 * — while an unrecognised one is a caller bug. Collapsing them into a single
 * "unknown command" would make a not-yet-built feature indistinguishable from a
 * typo, and the caller would go looking in the wrong place.
 *
 * Handlers arrive one blast radius at a time. Phase 6 added the free and
 * reversible ones — DNS records, hosting suspend/unsuspend — which DO contact
 * providers. Phase 7 added hosting.change_plan (reversible spend).
 *
 * Phase 8 added domain.renew, which DOES spend a rupee that does not come
 * back — performable, but not live-eligible until the engine grows a spend
 * control.
 *
 * Phase 9 (24 Sep 2026) added domain.register, which cannot be undone — live
 * only behind its own gate and a spend limit.
 *
 * Still unhandled: hosting.provision, blocked on a product decision rather
 * than on effort (see engine-handlers-plan.ts).
 */
import type { EngineMode } from "./engine-mode";
import { upsertDnsRecord } from "./engine-handlers-dns";
import { suspendHosting, unsuspendHosting } from "./engine-handlers-hosting";
import { changeHostingPlan } from "./engine-handlers-plan";
import { renewDomainCommand } from "./engine-handlers-domain";
import { registerDomainCommand } from "./engine-handlers-register";

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
  /* Phase 6 — free and reversible. A DNS record can be set back, a suspended
     account can be unsuspended. Nothing below spends money; the ones that do
     arrive in Phases 7-9, one blast radius at a time. */
  "dns.record.upsert": upsertDnsRecord,
  "hosting.suspend": suspendHosting,
  "hosting.unsuspend": unsuspendHosting,
  /* Phase 7 — reversible spend. A bigger package costs real money on the
     DirectAdmin server and changing back undoes it.

     `hosting.provision` was meant to land beside this one and did NOT: DMS's
     createUser sets a Math.random() password it never returns, because its
     customers reach DirectAdmin by SSO from the DMS portal. An engine-created
     account for somebody with no portal user has no way in, and nothing
     reports that. See engine-handlers-plan.ts and Todos.md §D. */
  "hosting.change_plan": changeHostingPlan,
  /* Phase 8 — the first rupee that does not come back. Performable, and
     deliberately NOT live-eligible: see LIVE_INELIGIBLE_REASONS. */
  "domain.renew": renewDomainCommand,
  /* Phase 9 (24 Sep 2026) — irreversible. Live only behind its OWN gate,
     ENGINE_DOMAIN_REGISTER_LIVE=1 (engine-mode.ts OWN_LIVE_GATES), and only
     within the spend limit in engine-register-policy.ts. */
  "domain.register": registerDomainCommand,
};

export function handlerFor(command: KnownCommand): CommandHandler | null {
  return HANDLERS[command] ?? null;
}
