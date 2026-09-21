/**
 * `dns.record.upsert` — set one DNS record on a domain we hold.
 *
 * In Phase 6 with suspend/unsuspend because it is free and reversible: a DNS
 * record can be changed back, and the worst case is a site pointing at the
 * wrong place until somebody notices. Nothing here spends money.
 *
 * ─── UPSERT, AND WHY IT READS FIRST ──────────────────────────────────────────
 * ResellerClub has separate add and update calls, so "set this record" needs
 * to know whether one already exists. Reading first also makes the command
 * idempotent in the way a caller expects: sending the same upsert twice leaves
 * one record, not two. A blind add would leave a domain with two A records for
 * the same host, which resolves round-robin and is a genuinely confusing
 * outage to diagnose.
 *
 * ─── WHAT TEST MODE DOES ─────────────────────────────────────────────────────
 * Reads, and reports what a live run would change. It does not write. As with
 * the hosting handlers, this is "no writes" rather than "offline" — the read
 * is a real call to ResellerClub.
 */
import { serverLogger } from "@/lib/server-logger";
import { attemptProviderWrite, providerRefused } from "./engine-attempt";
import type { CommandHandler, HandlerResult } from "./engine-command-registry";
import type { Reconciler, ReconcileVerdict } from "./engine-reconcile";

/**
 * ResellerClub is imported LAZILY, inside the calls that need it.
 *
 * `lib/resellerclub/client.ts` THROWS at module load when its env vars are
 * missing. A static import here would make the whole command registry
 * un-importable without ResellerClub configured — so `hosting.suspend`, which
 * only talks to DirectAdmin, would fail to load because of a registrar's
 * credentials. The command route would 500 before it could even tell you which
 * command you asked for.
 *
 * Deferring the import moves that failure to the one command that genuinely
 * needs the config, where it is a legible error instead of a dead route.
 */
async function rc() {
  const [{ getDNSRecords }, { ResellerClubAPI }] = await Promise.all([
    import("@/lib/integrations/resellerclub"),
    import("@/lib/resellerclub"),
  ]);
  return { getDNSRecords, ResellerClubAPI };
}

/** The record types this command will set. */
const ALLOWED_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT"] as const;
type RecordType = (typeof ALLOWED_TYPES)[number];

interface UpsertRequest {
  customerId: string;
  type: RecordType;
  /** Host, `@` for the domain itself. */
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

/**
 * Validate before touching anything.
 *
 * NS records are deliberately not allowed: changing nameservers moves the
 * whole domain's DNS elsewhere, which is neither small nor easily reversed by
 * the same command — it belongs with the riskier operations, not here. SOA is
 * excluded for the same reason in the other direction: nothing good comes of
 * an integration editing it.
 */
function parseUpsert(payload: Record<string, unknown>): UpsertRequest {
  const type = String(payload.type ?? "").toUpperCase();
  if (!(ALLOWED_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `"type" must be one of ${ALLOWED_TYPES.join(", ")}. Received ${JSON.stringify(payload.type)}. ` +
        "NS and SOA are deliberately not settable here — changing nameservers moves the whole " +
        "domain's DNS and is not a small reversible edit."
    );
  }

  const customerId = String(payload.customerId ?? "").trim();
  const name = String(payload.name ?? "").trim();
  const value = String(payload.value ?? "").trim();
  if (!customerId || !name || !value) {
    throw new Error('"customerId", "name" and "value" are all required in the payload.');
  }

  /**
   * ResellerClub enforces a 7200s floor and silently raises anything lower.
   * Rejecting instead, so a caller that asked for 300 finds out here rather
   * than wondering why its record takes two hours to change.
   */
  const ttl = Number(payload.ttl ?? 7200);
  if (!Number.isFinite(ttl) || ttl < 7200) {
    throw new Error(
      `"ttl" must be at least 7200 — ResellerClub's floor. Asking for ${payload.ttl} would be ` +
        "silently raised to 7200, so it is refused here rather than surprising you later."
    );
  }

  const priority = payload.priority === undefined ? undefined : Number(payload.priority);
  if (type === "MX" && (priority === undefined || !Number.isFinite(priority))) {
    throw new Error('An MX record needs a numeric "priority".');
  }

  return { customerId, type: type as RecordType, name, value, ttl, priority };
}

/** Compare the way the provider does: host and type identify a record. */
function findExisting(
  records: Array<Record<string, unknown>>,
  domain: string,
  req: UpsertRequest
) {
  const wantHost = req.name === "@" ? domain : req.name;
  return records.find((r) => {
    const host = String(r.name ?? r.host ?? "");
    const type = String(r.type ?? "").toUpperCase();
    return type === req.type && (host === wantHost || host === `${wantHost}.`);
  });
}

export const upsertDnsRecord: CommandHandler = async (ctx): Promise<HandlerResult> => {
  const req = parseUpsert(ctx.payload);
  const domain = ctx.subject;

  const { getDNSRecords, ResellerClubAPI } = await rc();
  const existing = await getDNSRecords({ domainName: domain, customerId: req.customerId });
  if (existing.kind !== "found") {
    /**
     * Thrown so the route records `transport: "not_sent"` — we have not
     * attempted a write, so nothing can have half-happened and the subject is
     * safe to release.
     */
    throw new Error(
      existing.kind === "not_found"
        ? `ResellerClub has no DNS for ${domain}. Is the domain in this account, and is DNS ` +
          `management activated on it?`
        : `Could not read DNS for ${domain}: ${existing.reason}`
    );
  }

  const current = findExisting(
    existing.records as Array<Record<string, unknown>>,
    domain,
    req
  );
  const currentValue = current ? String(current.value ?? "") : null;

  if (currentValue === req.value) {
    // Already what was asked for. Success, not an error — same reasoning as
    // "already suspended": a retry must not look like a problem.
    return {
      result: {
        ok: true,
        domain,
        type: req.type,
        name: req.name,
        changed: false,
        note: "The record already has this value; nothing to do.",
      },
    };
  }

  if (ctx.mode === "test") {
    return {
      result: {
        ok: true,
        domain,
        type: req.type,
        name: req.name,
        changed: false,
        dryRun: true,
        wouldChange: current
          ? `update ${req.type} ${req.name}: ${currentValue} -> ${req.value}`
          : `create ${req.type} ${req.name} = ${req.value}`,
        note: "Test mode: DNS was read but NOT changed.",
      },
    };
  }

  const recordData = {
    type: req.type,
    name: req.name,
    value: req.value,
    ttl: req.ttl,
    priority: req.priority,
  };

  /**
   * `updateDNSRecord`'s second argument is the RECORD id, not the customer id.
   * An earlier draft passed customerId with an `as never` to make it compile —
   * the cast silenced the type error and would have sent ResellerClub a
   * record-id that identifies a customer. AGENTS.md L5: a cast to get one
   * argument through stops checking the rest of them.
   */
  let res;
  if (current) {
    const recordId = current.id === undefined ? "" : String(current.id);
    if (!recordId) {
      throw new Error(
        `ResellerClub returned the existing ${req.type} record for ${req.name} without an id, ` +
          "so it cannot be updated in place. Delete it in the ResellerClub console and run " +
          "this again to create it fresh."
      );
    }
    res = await attemptProviderWrite(() =>
      ResellerClubAPI.updateDNSRecord(domain, recordId, recordData)
    );
  } else {
    res = await attemptProviderWrite(() =>
      ResellerClubAPI.addDNSRecord(domain, req.customerId, recordData)
    );
  }

  if (res.status === "error") {
    // ResellerClub answered. We know the record did not change, so this
    // releases the subject instead of holding it for a human.
    throw providerRefused(
      `ResellerClub refused the DNS change: ${res.message ?? "no reason given"}`
    );
  }

  serverLogger.warn(
    `[engine] DNS ${current ? "updated" : "created"} on ${domain}: ${req.type} ${req.name} = ${req.value}`
  );
  return {
    result: {
      ok: true,
      domain,
      type: req.type,
      name: req.name,
      value: req.value,
      changed: true,
      action: current ? "updated" : "created",
    },
  };
};

/**
 * Reconciler: does the record now hold the value we asked for?
 *
 * Answerable as a pure read, which is why this command gets one. The value is
 * compared rather than mere existence — a record that exists with the OLD
 * value means the write did not land, and reporting that as `done` would close
 * a command that changed nothing.
 */
export const reconcileDnsUpsert: Reconciler = async (ctx): Promise<ReconcileVerdict> => {
  let req: UpsertRequest;
  try {
    req = parseUpsert(ctx.request);
  } catch {
    // The stored request is unreadable, so nothing can be concluded from it.
    return "unknown";
  }

  const { getDNSRecords } = await rc();
  const existing = await getDNSRecords({
    domainName: ctx.subject,
    customerId: req.customerId,
  });
  if (existing.kind !== "found") return "unknown";

  const current = findExisting(
    existing.records as Array<Record<string, unknown>>,
    ctx.subject,
    req
  );
  if (!current) return "not_done";
  return String(current.value ?? "") === req.value ? "done" : "not_done";
};
