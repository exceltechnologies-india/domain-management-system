/**
 * dns.record.upsert — the other Phase 6 command.
 *
 * Threat model:
 *  - **`updateDNSRecord`'s second argument is the RECORD id, not the customer
 *    id.** An earlier draft passed customerId behind an `as never`, which
 *    compiled and would have sent ResellerClub a record-id identifying a
 *    customer. That is the single most important assertion in this file, and it
 *    is here because a cast hid it from the compiler (AGENTS.md L5).
 *  - **Upsert must not become "add twice".** Two A records for one host resolve
 *    round-robin, so half the visitors reach the old address — an outage that
 *    presents as "it works for me".
 *  - **NS and SOA are refused**, not silently allowed: changing nameservers
 *    moves the whole domain's DNS and is not the small reversible edit this
 *    command is scoped to.
 *  - **A TTL below ResellerClub's 7200 floor is refused rather than raised.**
 *    Silently accepting it means a caller who asked for 300 spends two hours
 *    wondering why their record has not changed.
 *  - **Test mode reads and does not write.**
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getDNSRecords = vi.fn();
const addDNSRecord = vi.fn();
const updateDNSRecord = vi.fn();

vi.mock("@/lib/integrations/resellerclub", () => ({
  getDNSRecords: (...a: unknown[]) => getDNSRecords(...a),
}));
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: {
    addDNSRecord: (...a: unknown[]) => addDNSRecord(...a),
    updateDNSRecord: (...a: unknown[]) => updateDNSRecord(...a),
  },
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  upsertDnsRecord,
  reconcileDnsUpsert,
} from "@/lib/integrations/engine-handlers-dns";

const PAYLOAD = {
  customerId: "cust-1",
  type: "A",
  name: "www",
  value: "203.0.113.10",
  ttl: 7200,
};

const ctx = (mode: "test" | "live", payload: Record<string, unknown> = PAYLOAD) => ({
  commandId: "c1",
  subject: "example.com",
  mode,
  payload,
});

const records = (...rs: Array<Record<string, unknown>>) => ({
  kind: "found" as const,
  records: rs,
});

beforeEach(() => {
  getDNSRecords.mockReset();
  addDNSRecord.mockReset();
  updateDNSRecord.mockReset();
  addDNSRecord.mockResolvedValue({ status: "success" });
  updateDNSRecord.mockResolvedValue({ status: "success" });
});

describe("the payload is validated before anything is read", () => {
  it.each(["NS", "SOA", "SRV", ""])("%p is refused as a record type", async (type) => {
    await expect(upsertDnsRecord(ctx("live", { ...PAYLOAD, type }))).rejects.toThrow(
      /"type" must be one of/
    );
    expect(getDNSRecords).not.toHaveBeenCalled();
  });

  it("the NS refusal says WHY, not just no", async () => {
    // CLAUDE.md §24: a bare "not allowed" sends somebody looking for a bug.
    await expect(upsertDnsRecord(ctx("live", { ...PAYLOAD, type: "NS" }))).rejects.toThrow(
      /moves the whole\s+domain's DNS|moves the whole domain's DNS/
    );
  });

  it.each(["customerId", "name", "value"])("a missing %s is refused", async (field) => {
    const payload = { ...PAYLOAD, [field]: "" };
    await expect(upsertDnsRecord(ctx("live", payload))).rejects.toThrow(/are all required/);
  });

  it("a TTL below the 7200 floor is refused, saying it would be raised anyway", async () => {
    await expect(upsertDnsRecord(ctx("live", { ...PAYLOAD, ttl: 300 }))).rejects.toThrow(
      /at least 7200/
    );
    await expect(upsertDnsRecord(ctx("live", { ...PAYLOAD, ttl: 300 }))).rejects.toThrow(
      /silently raised/
    );
  });

  it("an MX record without a priority is refused", async () => {
    await expect(
      upsertDnsRecord(ctx("live", { ...PAYLOAD, type: "MX", value: "mail.example.com" }))
    ).rejects.toThrow(/needs a numeric "priority"/);
  });

  it("a lowercase type is accepted — it is a spelling, not a different record", async () => {
    getDNSRecords.mockResolvedValue(records());
    const { result } = await upsertDnsRecord(ctx("live", { ...PAYLOAD, type: "cname", value: "x.example.com" }));
    expect(result.ok).toBe(true);
  });
});

describe("reading DNS first", () => {
  it("a domain with no DNS in the account throws, and writes nothing", async () => {
    getDNSRecords.mockResolvedValue({ kind: "not_found", reason: "not in account" });
    await expect(upsertDnsRecord(ctx("live"))).rejects.toThrow(/no DNS for example.com/);
    // The error names the two things that are actually wrong when this happens.
    await expect(upsertDnsRecord(ctx("live"))).rejects.toThrow(/DNS\s+management activated|DNS management activated/);
    expect(addDNSRecord).not.toHaveBeenCalled();
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });

  it("a failed read throws with the reason", async () => {
    getDNSRecords.mockResolvedValue({ kind: "hard_failure", reason: "RC 500" });
    await expect(upsertDnsRecord(ctx("live"))).rejects.toThrow(/RC 500/);
    expect(addDNSRecord).not.toHaveBeenCalled();
  });

  it("a record already holding the asked-for value is a success with no write", async () => {
    getDNSRecords.mockResolvedValue(
      records({ id: "r1", type: "A", name: "www", value: "203.0.113.10" })
    );
    const { result } = await upsertDnsRecord(ctx("live"));
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(addDNSRecord).not.toHaveBeenCalled();
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });

  it("`@` matches the record stored under the domain name itself", async () => {
    getDNSRecords.mockResolvedValue(
      records({ id: "r1", type: "A", name: "example.com", value: "203.0.113.10" })
    );
    const { result } = await upsertDnsRecord(ctx("live", { ...PAYLOAD, name: "@" }));
    expect(result.changed).toBe(false);
  });
});

describe("test mode", () => {
  it("says what a live run would create, and writes nothing", async () => {
    getDNSRecords.mockResolvedValue(records());
    const { result } = await upsertDnsRecord(ctx("test"));
    expect(result).toMatchObject({ dryRun: true, changed: false });
    expect(result.wouldChange).toMatch(/create A www = 203.0.113.10/);
    expect(addDNSRecord).not.toHaveBeenCalled();
  });

  it("says what it would change, with the current value, when one exists", async () => {
    getDNSRecords.mockResolvedValue(
      records({ id: "r1", type: "A", name: "www", value: "198.51.100.1" })
    );
    const { result } = await upsertDnsRecord(ctx("test"));
    expect(result.wouldChange).toMatch(/198.51.100.1 -> 203.0.113.10/);
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });
});

describe("a live write", () => {
  it("creates when nothing matches, passing the CUSTOMER id", async () => {
    getDNSRecords.mockResolvedValue(records());
    const { result } = await upsertDnsRecord(ctx("live"));
    expect(addDNSRecord).toHaveBeenCalledTimes(1);
    expect(addDNSRecord.mock.calls[0][0]).toBe("example.com");
    expect(addDNSRecord.mock.calls[0][1]).toBe("cust-1");
    expect(result).toMatchObject({ changed: true, action: "created" });
  });

  it("updates through the RECORD id — never the customer id", async () => {
    /**
     * The regression this file exists for. `as never` made customerId compile
     * in this slot; the two ids look alike in a call and mean entirely
     * different things to ResellerClub.
     */
    getDNSRecords.mockResolvedValue(
      records({ id: "rec-99", type: "A", name: "www", value: "198.51.100.1" })
    );
    const { result } = await upsertDnsRecord(ctx("live"));
    expect(updateDNSRecord).toHaveBeenCalledTimes(1);
    expect(updateDNSRecord.mock.calls[0][1]).toBe("rec-99");
    expect(updateDNSRecord.mock.calls[0][1]).not.toBe("cust-1");
    expect(addDNSRecord).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: true, action: "updated" });
  });

  it("refuses rather than duplicating when the existing record has no id", async () => {
    // A blind add here is exactly the round-robin outage in the header.
    getDNSRecords.mockResolvedValue(
      records({ type: "A", name: "www", value: "198.51.100.1" })
    );
    await expect(upsertDnsRecord(ctx("live"))).rejects.toThrow(/without an id/);
    await expect(upsertDnsRecord(ctx("live"))).rejects.toThrow(/Delete it in the ResellerClub console/);
    expect(addDNSRecord).not.toHaveBeenCalled();
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });

  it("a ResellerClub error becomes a throw, not a reported success", async () => {
    getDNSRecords.mockResolvedValue(records());
    addDNSRecord.mockResolvedValue({ status: "error", message: "invalid host" });
    await expect(upsertDnsRecord(ctx("live"))).rejects.toThrow(/invalid host/);
  });
});

describe("the reconciler compares the VALUE, not mere existence", () => {
  const rctx = { subject: "example.com", request: PAYLOAD as Record<string, unknown> };

  it("the asked-for value present → done", async () => {
    getDNSRecords.mockResolvedValue(
      records({ id: "r1", type: "A", name: "www", value: "203.0.113.10" })
    );
    expect(await reconcileDnsUpsert(rctx)).toBe("done");
  });

  it("the record exists with the OLD value → not_done", async () => {
    // Existence alone would report `done` and close a command that changed
    // nothing — the customer's site still points at the old address.
    getDNSRecords.mockResolvedValue(
      records({ id: "r1", type: "A", name: "www", value: "198.51.100.1" })
    );
    expect(await reconcileDnsUpsert(rctx)).toBe("not_done");
  });

  it("no such record → not_done", async () => {
    getDNSRecords.mockResolvedValue(records());
    expect(await reconcileDnsUpsert(rctx)).toBe("not_done");
  });

  it.each([
    { kind: "not_found", reason: "gone" },
    { kind: "hard_failure", reason: "RC 500" },
  ])("an unreadable provider ($kind) → unknown", async (outcome) => {
    getDNSRecords.mockResolvedValue(outcome);
    expect(await reconcileDnsUpsert(rctx)).toBe("unknown");
  });

  it("an unreadable stored request → unknown, and asks nothing", async () => {
    const r = await reconcileDnsUpsert({ subject: "example.com", request: { type: "NS" } });
    expect(r).toBe("unknown");
    expect(getDNSRecords).not.toHaveBeenCalled();
  });

  it("a thrown read is left to reconcileCommand to turn into unknown", async () => {
    // This reconciler does NOT swallow — engine-reconcile's wrapper does, in one
    // place, so every reconciler gets the same treatment.
    getDNSRecords.mockRejectedValue(new Error("ECONNRESET"));
    await expect(reconcileDnsUpsert(rctx)).rejects.toThrow(/ECONNRESET/);
  });
});
