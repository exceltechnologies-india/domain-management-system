/**
 * lib/reselleros/upgrade-request.ts — sending an upgrade request to
 * ResellerOS. Pinned: the key and body are sent once, never retried; each
 * answer lands in the class of who can fix it; a timeout "may have been
 * recorded", a refused connection was not.
 */
// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { sendUpgradeRequest, upgradeRequestRefusalMessage, type UpgradeRequestBody } from "@/lib/reselleros/upgrade-request";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test", DMS_PANEL_API_KEY: "k".repeat(20) };
const BODY: UpgradeRequestBody = {
  dmsUserId: "U1",
  email: "a@example.test",
  fullName: "Asha Rao",
  domain: "rao.in",
  currentPlan: "starter",
  targetPlan: "plus",
  estimateRupees: 420,
};

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("sendUpgradeRequest", () => {
  it("not configured → no request", async () => {
    const f = vi.fn();
    expect((await sendUpgradeRequest(BODY, { env: {}, fetchImpl: f as unknown as typeof fetch })).kind).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the body with the panel key to /api/dms/upgrade-request", async () => {
    const f = reply(200, { success: true, leadId: "L-9", alreadyRequested: true });
    const out = await sendUpgradeRequest(BODY, { env: ENV, fetchImpl: f });
    expect(out).toEqual({ kind: "ok", leadId: "L-9", alreadyRequested: true });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ros.example.test/api/dms/upgrade-request");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ENV.DMS_PANEL_API_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual(BODY);
  });

  it("400 → refused with ResellerOS's message", async () => {
    expect(await sendUpgradeRequest(BODY, { env: ENV, fetchImpl: reply(400, { error: "bad" }) })).toEqual({ kind: "refused", message: "bad" });
  });

  it.each([401, 503])("%i → config", async (status) => {
    expect((await sendUpgradeRequest(BODY, { env: ENV, fetchImpl: reply(status, { error: "x" }) })).kind).toBe("config");
  });

  it("500 with a message → failed, carrying ResellerOS's words", async () => {
    const out = await sendUpgradeRequest(BODY, { env: ENV, fetchImpl: reply(500, { error: "Database error. Nothing was charged." }) });
    expect(out).toEqual({ kind: "failed", message: "Database error. Nothing was charged." });
  });

  it("a timeout → may have been recorded, one attempt", async () => {
    const f = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const out = await sendUpgradeRequest(BODY, { env: ENV, fetchImpl: f as unknown as typeof fetch });
    expect(out).toMatchObject({ kind: "unreachable", mayHaveRecorded: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a refused connection → not recorded", async () => {
    const f = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(await sendUpgradeRequest(BODY, { env: ENV, fetchImpl: f as unknown as typeof fetch })).toMatchObject({
      kind: "unreachable",
      mayHaveRecorded: false,
    });
  });
});

describe("upgradeRequestRefusalMessage", () => {
  it("a timeout says check email before asking again", () => {
    const m = upgradeRequestRefusalMessage({ kind: "unreachable", detail: "t", mayHaveRecorded: true }, "help@example.test");
    expect(m).toMatch(/may have been recorded/);
    expect(m).toMatch(/check your email before asking again/);
    expect(m).toMatch(/Nothing was charged/);
  });
});
